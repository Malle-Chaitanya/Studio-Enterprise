# Deploying CloudFuze Studio Migrate

The complete picture: what runs where, why it is shaped this way, how to bring it up
the first time, how a release happens after that, and what each failure looks like.

Everything here was measured against the real target host on 2026-08-13. Where a number
or a name appears, it came from a command whose output is shown.

- [DEPLOY-MANUAL.md](DEPLOY-MANUAL.md) — the short runbook for a by-hand deploy
- This file — the whole thing, including the reasoning. §8 is the workflow reference.

A third file, `DEPLOY-GITHUB-ACTIONS.md`, was deleted on 2026-08-13: it still described
the abandoned rsync + systemd design and told the reader to install a
`deploy/csge-server.service` that no longer exists. Two docs, one deploy.

---

## 1. What gets deployed

Two applications and a database:

| Component | Source | Runs as |
|---|---|---|
| **API** | `server/` — Node 20 + TypeScript (ESM), Express 4 | `api` container |
| **SPA** | `web/` — React 18 + Vite 6 | `web` container (nginx) |
| **Database** | MongoDB 7, native driver, no ODM | `mongo` container |

The API is a Node service that **shells out to Python**. `adkDeployer.ts:478` spawns
`scripts/adk_deploy.py` for every Agent Engine deployment, because Agent Engine is a
Python-SDK-only flow — it packages code and requirements, stages them to GCS, and builds
a container. Python is a runtime dependency of the API, not developer tooling. This
single fact drives most of the image design in §4.

---

## 2. The target host, as measured

```
$ ssh -p 63152 laxman@208.70.248.68
Ubuntu · OpenSSH 9.6p1 · Docker 28.1.1 · Node v24.16.0 · npm 11.13.0 · rsync 3.2.7
$ ls /etc/nginx/sites-enabled/ | wc -l
41
$ docker ps -q | wc -l
75
$ groups | tr ' ' '\n' | grep -c docker
1
```

This is a **shared** box. It runs 41 nginx sites and 75 containers across 17
`/data/<project>/` directories. Three consequences run through this entire document:

1. **`laxman` is in the `docker` group**, so `docker` needs no `sudo`. This is what makes
   the whole deploy possible without a sudoers rule or a root password in CI.
2. **Ports are crowded.** 8080 is taken (`ats-app`), and so are 27017/27018/27019/28017/
   29019/37017/37019. Defaults are not available; see §3.
3. **One nginx serves everything.** A bad config or a catch-all `server_name` takes down
   40 other production sites.

### Why Docker

The host's convention is unambiguous, and matching it costs less than fighting it. It
also removed two problems the earlier systemd + rsync design had:

- **`scripts/adk_deploy.py` would have been missing.** `tsc` does not emit it and
  `copyAssets.mjs` only copies `src/connectors/fixtures`, so it is absent from `dist/` —
  which is all rsync shipped. `adkDeployer.ts:470` resolves it as the relative path
  `scripts/adk_deploy.py` against the process CWD, so every Agent Engine deployment would
  have failed with "deploy produced no JSON result". The image `COPY`s it explicitly and
  the build asserts it is there.
- **Node 20 vs 24.** CI builds on 20, the host runs 24. The image pins its own
  interpreters, so the host's version stops mattering.

---

## 3. Hostname, ports and routing

**`studioent.cftools.live`** — A record verified 2026-08-13:

```
$ nslookup studioent.cftools.live
Addresses:  208.70.248.68
```

```
                    studioent.cftools.live  (443/80)
                              │
                       host nginx  ── shared with 40 other sites
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
   /  → 127.0.0.1:8084   /api/ → 127.0.0.1:8083  /callback/ → 127.0.0.1:8083
   web container          api container            api container
                                   │
                          compose network
                                   │
                          mongo:27017 (unpublished)
```

### Port 8083, not 8080

`config.ts:9` defaults `PORT` to 8080. On this host 8080 is bound by the `ats-app`
container. On the default the API either dies with `EADDRINUSE`, or — if nginx reloads
first — `studioent.cftools.live` comes up quietly proxying **someone else's app**, which
looks exactly like a successful deploy. Compose sets `PORT: 8083` and the nginx config
matches.

### `/callback/` is not under `/api/`

`server.ts:56` mounts `legacyAuthRouter` at `/`:

```
routes/auth.ts:461  legacyAuthRouter.get('/callback/microsoft', msCallback);
routes/auth.ts:462  legacyAuthRouter.get('/callback/google',    googleCallback);
```

Those are the redirect URIs registered with Azure and Google. Without a dedicated
`location /callback/` block, the SPA's catch-all answers them with `index.html`: sign-in
succeeds, the browser redirects back, and the page is blank with the auth code silently
discarded — **and nothing in the server logs**, because the request never reached Express.

### Never `server_name _` on the host

41 sites share this nginx; a catch-all swallows every unmatched request meant for them.
(`server_name _` *is* used inside the web container, where exactly one site exists.)

The same crowding is why every smoke test sends `-H "Host: studioent.cftools.live"`. A
bare-IP `curl` lands on whichever block wins the `default_server` race, so it can pass
while our site is entirely broken.

### Mongo gets its own container

`MONGO_HOST` conventionally points at 27019 — but on this host 27019 is `agents-mongo`,
an unrelated project. Compose overrides it to the private `mongo` service, reachable only
on the compose network. Inspect it with `docker compose exec mongo mongosh`.

---

## 4. The images

### `server/Dockerfile`

Base is `python:3.13-slim` with Node 20 layered on, not `node:20-slim` with Python added.
The ADK/Vertex stack is the fragile half, so the image is built on the interpreter the
pipeline is proven against.

**The Python requirements cannot be installed in one pass.** They genuinely conflict:

```
google-adk 2.6.2               requires google-genai >=2.9,<3
google-cloud-aiplatform 1.93.0 requires google-genai <2.0.0
```

No version satisfies both; a single `pip install -r` fails with `ResolutionImpossible`.
The development machine the pipeline is proven on is in exactly that conflicting state —
`pip check` reports it — and every deployment works, because aiplatform's genai pin is
stricter than its actual use. The Dockerfile reproduces that end state with two sequential
installs and then **asserts every import `adk_deploy.py` performs actually resolves**.
Verified in a clean container:

```
google-adk 2.6.2 · google-cloud-aiplatform 1.93.0 · google-genai 2.16.0
OK google.oauth2.service_account · vertexai.agent_engines
OK vertexai.preview.reasoning_engines · google.adk.tools · google.cloud.storage
```

`google-genai` is pinned because unpinned it floated to 2.18.0 — a version nothing has
been tested against. See `server/requirements.txt` for what must **not** be added
(`google-cloud-secret-manager` shadows the `google.cloud` namespace and silently turns
every `VertexAiSearchTool` into a no-op).

Verified by running the built image:

```
node v20.20.2 · python 3.13.15 · cwd /app · user csge uid=10001
scripts/adk_deploy.py PRESENT · dist/server.js PRESENT · adk_deploy.py --help OK
```

### `web/Dockerfile`

Builds with Node 20, serves with `nginx:1.27-alpine`. Cache policy lives in
`web/nginx-spa.conf` beside the SPA — immutable `/assets/` (Vite content-hashes them),
`no-store` on `index.html` (the one filename that does not change between releases, so a
cached copy pins browsers to an asset bundle the next deploy deletes).

---

## 5. Configuration

Compose supplies everything about *where this is deployed* through `environment:`, which
takes precedence over `env_file`. `/data/studio-ent/.env` therefore needs **only secrets**:

```
MS_CLIENT_ID · MS_CLIENT_SECRET · GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET
(optional: INSTRUCTION_LLM_*, CLOUDFUZE_GCP_PROJECT, GEMINI_PROJECT_FALLBACK, …)
```

Compose sets these, so the file cannot get them wrong:

| Variable | Value | Why |
|---|---|---|
| `PORT` | `8083` | 8080 is taken |
| `MONGO_HOST` | `mongodb://mongo:27017` | 27019 belongs to another project |
| `WEB_ORIGIN` | `https://studioent.cftools.live` | pinned CORS origin (`server.ts:21`) **and** the OAuth popup's `postMessage` target (`auth.ts:151`) |
| `PUBLIC_BASE_URL` | `https://studioent.cftools.live` | |
| `MS_REDIRECT_URI` | `…/callback/microsoft` | must match Azure exactly |
| `GOOGLE_REDIRECT_URI` | `…/callback/google` | must match Google exactly |
| `GOOGLE_SA_KEY_FILE` | `/run/secrets/service_account.json` | see below |

That precedence is load-bearing, not incidental. **The current `.env` declares
`MS_REDIRECT_URI` and `GOOGLE_REDIRECT_URI` twice**, and the later `localhost:8080` pair
wins under last-wins parsing (systemd `EnvironmentFile` and dotenv behave the same way).
Compose makes the correct values authoritative regardless — but **delete the duplicates
anyway**. This stops them mattering; it does not make the file correct.

Both redirect URIs must be registered **verbatim** with the Azure app registration and
the Google OAuth client. An unregistered redirect is rejected by the provider before our
code runs.

### The service account file is required

`/data/studio-ent/service_account.json` must exist. The deploy preflights it and fails
before tearing anything down.

`adk_deploy.py:565` reads `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SA_KEY_FILE` and
expects a **path**. It never reads `GOOGLE_SA_KEY_JSON` — that form works only for the
Node half (`auth/google.ts:16`, which prefers JSON over FILE). With only the JSON form
set, Node authenticates perfectly, `/api/health` is green, the app looks entirely
healthy, and **every Agent Engine deployment fails**. That is the worst failure shape
available, which is why it is a hard gate rather than a warning.

Compose mounts it read-only at `/run/secrets/service_account.json`. It is never baked
into an image — the images go to GHCR and the repo is public.

```bash
chmod 600 /data/studio-ent/.env /data/studio-ent/service_account.json
```

---

## 6. Layout on the host

```
/data/studio-ent/
├── .env                    secrets only, 600
├── service_account.json    600 — required, see §5
└── docker-compose.yml      shipped by the deploy workflow
```

Application code lives in images, not on the host. `.env` and the key sit **outside** any
sync target, so no deploy can remove them.

---

## 7. First-time setup

Only nginx needs root. Everything else is `laxman`.

```bash
# --- as laxman ---
cd /data/studio-ent
# put .env and service_account.json in place, then:
chmod 600 .env service_account.json

# --- as root: nginx is shared with 40 other sites ---
cp deploy/nginx-csge.conf /etc/nginx/sites-available/csge
ln -sf /etc/nginx/sites-available/csge /etc/nginx/sites-enabled/csge
nginx -t                       # MANDATORY — a bad config takes all 41 sites down
systemctl reload nginx

# once the site answers on :80
certbot --nginx -d studioent.cftools.live
```

certbot rewrites `sites-available/csge` in place, adding the 443 block and the 80→443
redirect. Never hand-write TLS into that file and then re-run certbot over it.

No systemd unit and no sudoers rule. `restart: unless-stopped` survives a host reboot via
the Docker daemon.

### GHCR access

The first workflow run publishes both packages **private**. Either make them public (the
repo already is) at `github.com/users/Malle-Chaitanya/packages` → package → Package
settings → Change visibility, or run `docker login ghcr.io` once on the host with a PAT
carrying `read:packages`. Public is simpler and matches the repo.

---

## 8. The release pipeline

`.github/workflows/deploy.yml`, on push to `main` **or `business`**:

```
verify   npm ci · typecheck · vitest · (web) typecheck
   │     ── gate first: publishing an image that fails tests puts a broken
   │        artifact in the registry under a real tag
   ▼
build    docker build server/ + web/  →  push to GHCR
   │     tagged :<commit-sha> AND :latest
   ▼
deploy   ssh → scp docker-compose.yml → preflight → compose pull → up -d
         → smoke test API directly → smoke test through nginx → compose ps
```

`verify` sets four placeholder secrets. `config.ts` Zod-parses `process.env` at **import**
time and calls `process.exit(1)` on a missing value, which kills every suite that
transitively imports `logger` or `db/core` before its first assertion. Do not "fix" this
with a test-mode bypass — the fail-fast is what stops a misconfigured server booting in
production.

### Which branch deploys

`business` is a trigger branch, not just `main`. The workflow files have only ever lived
on `business`; `main` does not have them. With a main-only trigger the deploy could never
fire, and **`workflow_dispatch` would not rescue it** — GitHub only offers *Run workflow*
for a workflow that exists on the **default branch**, which is why `gh workflow list`
shows CI and nothing else. A push to `business` is currently the only path to the host.
Once `business` merges to `main`, drop it from the trigger list and the manual button
appears.

### Secrets

All five are present and verified as of 2026-08-13:

| Name | Value |
|---|---|
| `DEPLOY_SSH_KEY` | private key, including BEGIN/END lines |
| `DEPLOY_HOST` | `208.70.248.68` |
| `DEPLOY_USER` | `laxman` |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -p 63152 -H 208.70.248.68` — all three lines |
| `DEPLOY_PORT` | `63152` |

Repo-level secrets are visible to a job with `environment: production`, so they need no
duplication. `DEPLOY_PORT` is read as `secrets.DEPLOY_PORT || vars.DEPLOY_PORT || 22`:
reading only `vars` meant a port added as a secret — the obvious place, beside the other
four — resolved to empty and fell back to 22, failing at connect with a timeout that says
nothing about the cause.

`DEPLOY_KNOWN_HOSTS` is pinned deliberately. `StrictHostKeyChecking yes` means a changed
or spoofed host key fails the deploy instead of being trusted silently. `ssh-keyscan`
needs `-p 63152`; without it you scan a closed port 22 and get nothing.

### Deploying by hand

```bash
cd /data/studio-ent
export TAG=<commit-sha>        # omit for :latest
docker compose pull
docker compose up -d --remove-orphans
```

### Rollback

```bash
TAG=<previous-sha> docker compose up -d
```

Every deploy tags by commit SHA as well as `latest`, so rollback pulls a known artifact —
no rebuild, no guessing which `latest` was live.

---

## 9. Verifying

```bash
cd /data/studio-ent
docker compose ps                                   # three services Up, api healthy
curl -s http://127.0.0.1:8083/api/health            # API directly
curl -s -H "Host: studioent.cftools.live" http://127.0.0.1/api/health
docker compose logs --tail 50 api
```

`/api/health` must return `{"status":"ok","tool":"CloudFuze Studio Migrate",…}`.

The two curls are separate on purpose: they fail for different reasons, and one combined
check hides which broke. The first proves the container is up and configured; the second
proves nginx routes to it.

Then load the site and run one migration end to end. Watch **progress streaming**: if the
log fills in only when the run finishes, nginx is buffering the SSE stream and
`proxy_buffering off` did not take effect.

### Deploying is not the same as working

A deployed agent's behaviour is **frozen at deploy time**. Connector scopes, tool
definitions and instructions are baked into the Reasoning Engine's pickle; they are not
re-read from the repo at inference. Fixing a connector in `registry.ts` changes nothing
for agents already deployed.

This bit hard on 2026-08-13. Google Drive failed on a live agent with
`unauthorized_client`, which reads exactly like a missing domain-wide-delegation grant.
It was not: the grant was fine, and the same credentials succeeded through the production
auth path. The agent had been deployed at 10:54:31Z and the commit changing the scope
from `drive.readonly` to `drive` landed at 11:10:58Z — sixteen minutes later. The fix was
a redeploy, and the near-miss was reconfiguring the customer's Workspace to authorize a
scope the codebase had deliberately abandoned.

**When a fix "did not take", compare the deploy timestamp against the commit timestamp
before changing anything else.** Reasoning Engine logs will not help — payload content
comes back `"<elided>"` and tool errors never raise severity above INFO, so a 72-hour
`severity>="WARNING"` query returns zero rows while the tool is visibly failing. The
agent's own reply is the only place the error text exists:

```bash
cd server && npx tsx src/spikes/_diag_probe_connectors.ts
```

---

## 10. Failure reference

| Symptom | Cause |
|---|---|
| deploy fails at preflight naming `service_account.json` | file missing — without it Node still authenticates and only ADK deploys fail (§5) |
| `api` restart-loops immediately | missing/misnamed secret in `.env`; `docker compose logs api` names it — `config.ts` is fail-fast by design |
| `api` exits with `EADDRINUSE` | something bypassed compose's `PORT: 8083`; 8080 is `ats-app` |
| `/api/health` returns another app's JSON | curled the bare IP with no `Host:` header on a 41-site nginx |
| 502 from nginx, containers healthy | host nginx on the wrong port — API 8083, SPA 8084 |
| OAuth popup signs in, then hangs blank | `location /callback/` missing (SPA answered with `index.html`), or a stale `WEB_ORIGIN` |
| provider rejects sign-in before it reaches us | redirect URIs not registered verbatim with Azure / Google |
| CORS blocked on every `/api/` call | `WEB_ORIGIN` is not exactly `https://studioent.cftools.live` |
| both redirect URIs look right but sign-in still goes to localhost | duplicate keys later in `.env`; last-wins (§5) |
| progress bar jumps 0% → done | nginx buffering the SSE stream |
| migration data in another project's database | `MONGO_HOST` reaching host `27019` (`agents-mongo`) |
| `docker compose pull` denied | GHCR packages still private (§7) |
| a connector fix "did not take" | the agent predates the fix — check `adkDeployments.deployedAt` vs the commit (§9) |
| a re-run skips with `already exists` | no drift detected. A rename now counts as drift; otherwise use `forceRedeploy` |
| Agent Engine deploys fail with "deploy produced no JSON result" | `scripts/adk_deploy.py` not reachable from the process CWD |

---

## 11. What is deliberately not here

- **No secrets in the deploy.** `.env` and the SA key live on the host; the workflow never
  carries them. Change a value on the host and restart.
- **No Mongo migration step.** Collections and indexes are created idempotently at boot in
  `db/mongo.ts`.
- **No build on the host.** CI builds the images; devDependencies never reach production.
- **No systemd unit.** `deploy/csge-server.service` was removed — under compose it is dead
  config, and installing both would put two processes on 8083.
- **No sudoers rule and no root password in CI.** `laxman` is in the `docker` group, which
  is the entire reason this design works. Do not add a blanket root grant to a box serving
  41 production sites.
