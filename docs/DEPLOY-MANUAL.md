# Manual deploy — do this once by hand, then automate it

The GitHub Actions workflow in [DEPLOY-GITHUB-ACTIONS.md](DEPLOY-GITHUB-ACTIONS.md) does
exactly these steps. Running them by hand first means the automated run is repeating a
path that is known to work, instead of discovering the host for the first time.

Verified against the target host on 2026-08-13: Ubuntu, OpenSSH 9.6p1, **Node v24.16.0**,
npm 11.13.0, rsync 3.2.7, nginx already serving 41 other sites.

## Settled layout

No dedicated service user: the API runs as `laxman`. Everything lives under
`/data/studio-ent`:

```
/data/studio-ent/.env       the environment — OUTSIDE the rsync targets, so a deploy
                            with --delete can never remove it
/data/studio-ent/server/    dist/ + package.json + node_modules   (SERVER_DIR)
/data/studio-ent/web/       the built SPA served by nginx          (WEB_DIR)
```

The unit, the nginx config and `deploy.yml` are already pointed here. `ProtectHome=true`
was removed from the unit — it hides `/home`, which is wrong for a service running as a
real login user.

## The hostname

**`studioent.cftools.live`** — A record verified on 2026-08-13:

```
$ nslookup studioent.cftools.live
Addresses:  208.70.248.68
```

`deploy/nginx-csge.conf` already carries that `server_name`. Do **not** replace it with
`server_name _`: `sites-enabled` on this host has **41 entries** (counted 2026-08-13 —
`aicommunication.cftools.live`, `ats.cftools.live`, `itsmmigration.cftools.live`,
`gemco`, and ~37 more), and a catch-all would swallow every one of their unmatched
requests.

The same crowding is why the deploy's smoke test sends an explicit
`-H "Host: studioent.cftools.live"`. A bare-IP `curl` on a 41-site nginx lands on
whichever server block wins the `default_server` race, so it can pass while our site is
completely broken.

### TLS

Install the port-80 config first and confirm the site answers over HTTP, then:

```bash
sudo certbot --nginx -d studioent.cftools.live
```

certbot rewrites `sites-available/csge` in place — it adds the 443 block and the
80→443 redirect. Never hand-write TLS into that file and then re-run certbot over it.

### The three .env values the domain forces

`server/src/config.ts` defaults all three to localhost. Left at the defaults behind a
real hostname, every browser call is blocked by CORS and both sign-ins dead-end.
`/data/studio-ent/.env` must set:

```
PORT=8083
WEB_ORIGIN=https://studioent.cftools.live
MS_REDIRECT_URI=https://studioent.cftools.live/callback/microsoft
GOOGLE_REDIRECT_URI=https://studioent.cftools.live/callback/google
```

- **`PORT=8083` is not optional.** `config.ts:9` defaults to 8080, and 8080 is already
  bound on this host by an unrelated service (`127.0.0.1:8080`, confirmed 2026-08-13).
  On the default the API either dies with `EADDRINUSE` or, if nginx is reloaded first,
  leaves `studioent.cftools.live` quietly proxying somebody else's app. The unit and
  `nginx-csge.conf` are both on 8083.
- **Check `MONGO_HOST` before first boot.** Ports 27017, 27018, 27019, 28017, 29019,
  37017 and 37019 all have listeners on this box. `27019` is CS_GE's convention locally,
  but on a shared host it may already belong to another project — pointing at it blind
  would write migration data into someone else's database. Confirm which instance is
  ours before starting the service.

- `WEB_ORIGIN` is the pinned CORS origin (`server.ts:21`, `origin: config.WEB_ORIGIN,
  credentials: true`) **and** the target of the OAuth popup's `postMessage`
  (`routes/auth.ts:151`). A mismatch shows up as a popup that signs in fine and then
  never closes.
- Both redirect URIs must be added **verbatim** to the Azure app registration and the
  Google OAuth client. These must match exactly — an unregistered redirect is rejected
  by the provider before our code ever runs.
- Use `https://` only after certbot has run. If you test on plain HTTP first, the
  values must say `http://` for that window, and both provider registrations need the
  http form too — which is why it is less work to get the certificate first.

The callbacks live at the **root**, not under `/api/` (`server.ts:56` mounts
`legacyAuthRouter` at `/`). `nginx-csge.conf` has a `location /callback/` proxy block
for exactly this reason; without it the SPA catch-all answers the callback with
`index.html` and the auth code is dropped.

## Node version

CI builds on Node 20; this host runs Node 24. Pick one and make both match, or you are
shipping a combination nobody has tested. Either set `node-version: 24` in
`.github/workflows/ci.yml` and `deploy.yml`, or install Node 20 on the host. Doing the
manual deploy on 24 tells you whether 24 works at all.

## One-time host setup

As root, since /data/studio-ent was created as root:

```bash
# rsync runs as laxman and cannot write a root-owned directory.
mkdir -p /data/studio-ent/server /data/studio-ent/web
chown -R laxman:laxman /data/studio-ent

# .env arrived as mode 644 — world-readable, on a host that also runs three other
# projects. Every other user on that box could read the Microsoft and Google client
# secrets and the Mongo credentials.
chmod 600 /data/studio-ent/.env

# systemd unit
cp deploy/csge-server.service /etc/systemd/system/csge-server.service
systemctl daemon-reload
systemctl enable csge-server

# nginx — validate BEFORE reloading; 41 other sites share this nginx and a bad
# config takes them all down.
cp deploy/nginx-csge.conf /etc/nginx/sites-available/csge
ln -sf /etc/nginx/sites-available/csge /etc/nginx/sites-enabled/csge
nginx -t
systemctl reload nginx

# TLS, after the site answers on port 80.
certbot --nginx -d studioent.cftools.live
```

## Sudoers for the automated deploy (add now, needed later)

The current NOPASSWD list on the host is `/usr/sbin/nginx, /usr/bin/certbot, /bin/cp,
/bin/ln, /usr/bin/nginx` — it does **not** include the commands the workflow runs, and the
blanket `(ALL : ALL) ALL` rule requires a password, which a CI job cannot supply.

```bash
sudo visudo -f /etc/sudoers.d/csge-deploy
```
```
laxman ALL=(root) NOPASSWD: /bin/systemctl restart csge-server, \
                            /bin/systemctl reload nginx, \
                            /usr/sbin/nginx -t, \
                            /bin/journalctl -u csge-server *
```

## The deploy itself — run from your machine, in the repo root

```bash
# 1. Build both packages locally.
(cd server && npm ci && npm run build)
(cd web    && npm ci && npm run build)

# 2. Ship the API. package*.json travel so the host can install prod deps.
rsync -az --delete -e 'ssh -p 63152 -i csge_deploy' \
  server/dist/ laxman@208.70.248.68:/data/studio-ent/server/dist/
rsync -az -e 'ssh -p 63152 -i csge_deploy' \
  server/package.json server/package-lock.json laxman@208.70.248.68:/data/studio-ent/server/

# 3. Ship the SPA.
rsync -az --delete -e 'ssh -p 63152 -i csge_deploy' \
  web/dist/ laxman@208.70.248.68:/data/studio-ent/web/

# 4. Install prod deps and restart.
ssh -p 63152 -i csge_deploy laxman@208.70.248.68 \
  'cd /data/studio-ent/server && npm ci --omit=dev && sudo systemctl restart csge-server'
```

## Verify — do not skip

```bash
ssh -p 63152 -i csge_deploy laxman@208.70.248.68 '
  systemctl is-active csge-server
  curl -s localhost:8083/api/health
  sudo journalctl -u csge-server -n 30 --no-pager
'
```

`/api/health` must return `{"status":"ok",...}`. If the service is `activating` or
restarting in a loop, the journal will name the missing env var — `config.ts` is fail-fast
by design and exits rather than starting half-configured.

Then load the site in a browser and run one migration end to end. The thing to watch is
**migration progress streaming**: if the log fills in only when the run finishes, nginx is
buffering the SSE stream and the `proxy_buffering off` block did not take effect.

## What can go wrong, and what it looks like

| Symptom | Cause |
|---|---|
| `csge-server` restart-loops immediately | missing/misnamed var in `/data/studio-ent/.env`; the journal names it |
| service starts, `/api/health` 404s through nginx but works on `localhost:8083` | `sites-enabled/csge` not linked, or one of the other 41 sites' `server_name` is catching the request first |
| service dies at boot with `EADDRINUSE` | `PORT` missing from `.env`, so it fell back to the 8080 default, which is already taken |
| `/api/health` answers but returns another app's JSON | nginx still proxying 8080, or you curled the bare IP without a `Host:` header on a 41-site nginx |
| progress bar jumps from 0% to done | nginx buffering the SSE stream |
| stale UI after a deploy | `index.html` cached; check the `no-store` header actually reaches the browser |
| `sudo: a terminal is required` during the automated deploy | the sudoers rule above is missing |
| OAuth popup signs in, then hangs on a blank page and never closes | `location /callback/` missing from nginx (SPA answered with `index.html`), or `WEB_ORIGIN` still localhost so the popup's `postMessage` targets the wrong origin |
| provider rejects sign-in before reaching our server | `MS_REDIRECT_URI` / `GOOGLE_REDIRECT_URI` not registered verbatim in the Azure app / Google OAuth client |
| browser console shows CORS blocked on every `/api/` call | `WEB_ORIGIN` in `/data/studio-ent/.env` is not exactly `https://studioent.cftools.live` |
