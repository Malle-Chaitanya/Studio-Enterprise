# Manual deploy — do this once by hand, then automate it

The GitHub Actions workflow in [DEPLOY-GITHUB-ACTIONS.md](DEPLOY-GITHUB-ACTIONS.md) does
exactly these steps. Running them by hand first means the automated run is repeating a
path that is known to work, instead of discovering the host for the first time.

Verified against the target host on 2026-08-13: Ubuntu, OpenSSH 9.6p1, **Node v24.16.0**,
npm 11.13.0, rsync 3.2.7, nginx already serving three other sites.

## Two decisions to make first

**1. Which user runs the API.** `deploy/csge-server.service` ships with `User=csge`, and
that user does not exist on the host. Either:

- **Create it** (recommended — the API then cannot read your home directory, which is what
  `ProtectHome=true` in the unit is for):
  ```bash
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin csge
  ```
- **Or** change `User=`/`Group=` in the unit to `laxman` and accept that the API process
  runs as you.

**2. The hostname.** `deploy/nginx-csge.conf` says `csge.example.com`. Point a DNS A record
at the server first, then put the real name in `server_name`. Until DNS exists the site is
reachable only by IP, and certbot cannot issue a certificate.

## Node version

CI builds on Node 20; this host runs Node 24. Pick one and make both match, or you are
shipping a combination nobody has tested. Either set `node-version: 24` in
`.github/workflows/ci.yml` and `deploy.yml`, or install Node 20 on the host. Doing the
manual deploy on 24 tells you whether 24 works at all.

## One-time host setup

```bash
# Directories. Owned by the SSH user so rsync needs no sudo; readable by the service user.
sudo mkdir -p /opt/csge/server /var/www/csge
sudo chown -R laxman:laxman /opt/csge /var/www/csge

# Environment. Real secrets, never from CI, never in git.
sudo -u laxman cp /dev/null /opt/csge/server/.env
# ...fill it in from server/.env.example, then lock it down:
chmod 600 /opt/csge/server/.env
# If the service runs as `csge`, it must be able to read the file systemd hands it:
sudo chown csge:csge /opt/csge/server/.env   # skip if running as laxman

# systemd unit
sudo cp deploy/csge-server.service /etc/systemd/system/csge-server.service
sudo systemctl daemon-reload
sudo systemctl enable csge-server

# nginx — validate BEFORE reloading; three other sites share this nginx and a bad
# config takes them all down.
sudo cp deploy/nginx-csge.conf /etc/nginx/sites-available/csge
sudo ln -sf /etc/nginx/sites-available/csge /etc/nginx/sites-enabled/csge
sudo nginx -t
sudo systemctl reload nginx
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
  server/dist/ laxman@208.70.248.68:/opt/csge/server/dist/
rsync -az -e 'ssh -p 63152 -i csge_deploy' \
  server/package.json server/package-lock.json laxman@208.70.248.68:/opt/csge/server/

# 3. Ship the SPA.
rsync -az --delete -e 'ssh -p 63152 -i csge_deploy' \
  web/dist/ laxman@208.70.248.68:/var/www/csge/

# 4. Install prod deps and restart.
ssh -p 63152 -i csge_deploy laxman@208.70.248.68 \
  'cd /opt/csge/server && npm ci --omit=dev && sudo systemctl restart csge-server'
```

## Verify — do not skip

```bash
ssh -p 63152 -i csge_deploy laxman@208.70.248.68 '
  systemctl is-active csge-server
  curl -s localhost:8080/api/health
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
| `csge-server` restart-loops immediately | missing/misnamed var in `/opt/csge/server/.env`; the journal names it |
| service starts, `/api/health` 404s through nginx but works on `localhost:8080` | `sites-enabled/csge` not linked, or another site's `server_name` is catching the request first |
| progress bar jumps from 0% to done | nginx buffering the SSE stream |
| stale UI after a deploy | `index.html` cached; check the `no-store` header actually reaches the browser |
| `sudo: a terminal is required` during the automated deploy | the sudoers rule above is missing |
