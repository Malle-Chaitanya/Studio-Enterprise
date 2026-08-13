# Manual deploy — do this once by hand, then let the workflow do it

The GitHub Actions workflow in [DEPLOY-GITHUB-ACTIONS.md](DEPLOY-GITHUB-ACTIONS.md)
performs exactly these steps. Running them by hand first means the automated run is
repeating a path known to work rather than discovering the host for the first time.

Target host surveyed 2026-08-13: Ubuntu, OpenSSH 9.6p1, **Docker 28.1.1**, nginx
fronting **41 sites**, **75 running containers**, Node v24.16.0, npm 11.13.0.

## Why Docker

The host's convention is unambiguous — 75 containers, one `/data/<project>/` directory
per project, and `laxman` is in the `docker` group so **`docker` needs no sudo**. That
last fact removes the blocker the earlier systemd design could not get past: no
`systemctl restart` means no `/etc/sudoers.d/csge-deploy` rule and no root password in
a GitHub secret.

It also removes two failure modes the rsync design had:

- **`scripts/adk_deploy.py` would have been missing.** `tsc` does not emit it and
  `copyAssets.mjs` only copies `src/connectors/fixtures`, so it is absent from `dist/`.
  rsync shipped only `dist/`, and `adkDeployer.ts:470` resolves it as the relative path
  `scripts/adk_deploy.py` against the process CWD. Every Agent Engine deployment would
  have failed with "deploy produced no JSON result". The image `COPY`s it explicitly.
- **Node 20 vs 24 stops mattering.** The image pins its own interpreters.

## Layout

```
/data/studio-ent/
├── .env                    secrets only. Never in git, never in an image.
├── service_account.json    REQUIRED — see "The service account file" below.
└── docker-compose.yml      shipped by the deploy workflow
```

Application code lives in images on GHCR, not on the host.

| Component | Where | Port |
|---|---|---|
| API | `api` container | `127.0.0.1:8083` |
| SPA | `web` container (nginx) | `127.0.0.1:8084` |
| Mongo | `mongo` container | not published — compose network only |
| TLS + routing | **host** nginx | 80/443 |

## The hostname

**`studioent.cftools.live`** — A record verified 2026-08-13 → `208.70.248.68`.

Do not use `server_name _` in the host nginx: 41 sites share it and the catch-all would
hijack every unmatched request. (`server_name _` *is* used inside the web container,
where exactly one site exists.)

The same crowding is why the smoke tests send an explicit
`-H "Host: studioent.cftools.live"`. A bare-IP `curl` lands on whichever block wins the
`default_server` race, so it can pass while our site is entirely broken.

### TLS

Bring the site up on port 80 first, then:

```bash
sudo certbot --nginx -d studioent.cftools.live
```

certbot rewrites `sites-available/csge` in place, adding the 443 block and the 80→443
redirect. Never hand-write TLS into that file and then re-run certbot over it.

## The service account file — required, and not optional

`/data/studio-ent/service_account.json` must exist. The deploy preflight fails without
it, deliberately.

`adk_deploy.py:565` reads `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SA_KEY_FILE` and
expects a **path**. It never reads `GOOGLE_SA_KEY_JSON` — that form works only for the
Node half (`auth/google.ts:16`, which prefers JSON over FILE). So with only the JSON
form set, Node authenticates perfectly, the app looks healthy, and **every Agent Engine
deployment fails**. That is the worst failure shape available, which is why it is
checked before anything is torn down.

Compose mounts it read-only at `/run/secrets/service_account.json`. It is never baked
into an image — the images are published to GHCR and the repo is public.

```bash
chmod 600 /data/studio-ent/service_account.json
```

## The .env

Compose supplies everything about *where this is deployed* via `environment:`, which
takes precedence over `env_file`. So `.env` needs only secrets:
`MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and any
optional keys (`INSTRUCTION_LLM_*`, `CLOUDFUZE_GCP_PROJECT`, …).

Compose sets these, so the file does not need to and cannot get them wrong:

```
PORT=8083                     8080 is taken on this host by the ats-app container
MONGO_HOST=mongodb://mongo:27017
WEB_ORIGIN=https://studioent.cftools.live
PUBLIC_BASE_URL=https://studioent.cftools.live
MS_REDIRECT_URI=https://studioent.cftools.live/callback/microsoft
GOOGLE_REDIRECT_URI=https://studioent.cftools.live/callback/google
GOOGLE_SA_KEY_FILE=/run/secrets/service_account.json
```

That precedence is load-bearing. **The current `/data/studio-ent/.env` declares
`MS_REDIRECT_URI` and `GOOGLE_REDIRECT_URI` twice**, and the later `localhost:8080` pair
silently wins under last-wins parsing — both sign-ins would dead-end on a blank page
with nothing in the logs. Compose makes the correct values authoritative regardless.
**Delete the duplicate lines anyway**: this stops them mattering, it does not make the
file correct.

Both redirect URIs must also be registered **verbatim** in the Azure app registration
and the Google OAuth client. An unregistered redirect is rejected by the provider before
our code runs. Use the `https://` forms only after certbot.

### Mongo

`MONGO_HOST` in the file says `mongodb://localhost:27019`. On this host **27019 is
`agents-mongo`, an unrelated project's container.** Compose overrides it to the private
`mongo` service, so CS_GE gets its own instance on the compose network, unpublished.
Inspect it with `docker compose exec mongo mongosh`.

## One-time host setup

Only the nginx front door needs root; everything else runs as `laxman`.

```bash
# as laxman
cd /data/studio-ent
chmod 600 .env service_account.json

# as root — nginx is shared with 41 other sites, so validate before reloading
cp deploy/nginx-csge.conf /etc/nginx/sites-available/csge
ln -sf /etc/nginx/sites-available/csge /etc/nginx/sites-enabled/csge
nginx -t && systemctl reload nginx
certbot --nginx -d studioent.cftools.live      # after the site answers on :80
```

No systemd unit and no sudoers rule. Container restart policy is
`restart: unless-stopped`, which survives a host reboot via the Docker daemon.

### GHCR access

The first workflow run publishes both packages **private**. Either make them public
(the repo already is) at
`github.com/users/Malle-Chaitanya/packages` → each package → Package settings →
Change visibility, or `docker login ghcr.io` once on the host with a PAT carrying
`read:packages`. Public is simpler and matches the repo.

## The deploy

```bash
cd /data/studio-ent
export TAG=<commit-sha>          # or leave unset for :latest
docker compose pull
docker compose up -d --remove-orphans
```

## Verify — do not skip

```bash
cd /data/studio-ent
docker compose ps                                  # all three Up, api healthy
curl -s http://127.0.0.1:8083/api/health           # API directly
curl -s -H "Host: studioent.cftools.live" http://127.0.0.1/api/health   # through nginx
docker compose logs --tail 50 api
```

`/api/health` must return `{"status":"ok",...}`. If `api` restart-loops, the logs name
the missing env var — `config.ts` is fail-fast by design and exits rather than starting
half-configured.

Then load the site and run one migration end to end. Watch **progress streaming**: if
the log fills in only when the run finishes, nginx is buffering the SSE stream and the
`proxy_buffering off` block did not take effect.

## Rollback

```bash
TAG=<previous-sha> docker compose up -d
```

Every deploy tags images with the commit SHA as well as `latest`, so this is a pull of a
known artifact — no rebuild, no guessing which `latest` was live.

## What can go wrong, and what it looks like

| Symptom | Cause |
|---|---|
| deploy fails at preflight naming `service_account.json` | the file is missing; see above — without it Node still authenticates and only ADK deploys fail |
| `api` restart-loops immediately | missing/misnamed secret in `.env`; `docker compose logs api` names it |
| `api` exits with `EADDRINUSE` | something bypassed compose's `PORT: 8083`; 8080 is taken by `ats-app` |
| `/api/health` answers with another app's JSON | curled the bare IP with no `Host:` header on a 41-site nginx |
| 502 from nginx, containers healthy | host nginx pointing at the wrong port — API is 8083, SPA is 8084 |
| OAuth popup signs in then hangs on a blank page | `location /callback/` missing from the host nginx (the SPA answered with `index.html`), or a stale `WEB_ORIGIN` |
| provider rejects sign-in before it reaches us | redirect URIs not registered verbatim with Azure / Google |
| CORS blocked on every `/api/` call | `WEB_ORIGIN` is not exactly `https://studioent.cftools.live` |
| progress bar jumps 0% → done | nginx buffering the SSE stream |
| migration data appears in another project's database | `MONGO_HOST` reaching host `27019` (`agents-mongo`) instead of the compose `mongo` service |
| `docker compose pull` denied | GHCR packages still private — see "GHCR access" |
