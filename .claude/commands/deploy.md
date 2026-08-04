---
description: Project-specific deploy steps for CloudFuze Studio Migrate (build both apps, Mongo, service account). Orchestration/PR-to-prod is gstack /land-and-deploy.
---

# /deploy — CloudFuze Studio Migrate deploy

> This wraps **CS_GE-specific** deploy logic (two build targets, its own Mongo instance,
> service-account/Secret Manager setup, optional ADK Python deploy). For the general
> land-verify-prod orchestration, use gstack **`/land-and-deploy`**; this command is the
> project knowledge that command needs.

Target from `$ARGUMENTS` (e.g. `staging`, `prod`, or a host). Default: describe the steps and
confirm before doing anything that touches a live environment.

## Pre-deploy gates

1. `cd server && npm run typecheck` and `cd web && npm run typecheck` — both must be clean.
2. Confirm no secrets are being shipped: `.env`, `service_account.json`, `*sa-key*.json` stay
   out of the artifact. In prod these come from **Secret Manager**, not files.
3. Confirm the target Mongo is reachable. CS_GE uses its **own** instance (default
   `mongodb://localhost:27019`, db `csge`) so it never collides with sibling projects.

## Build

```bash
# Server → dist/
cd server && npm install && npm run build      # tsc -p tsconfig.json

# Web → web/dist/ (static bundle)
cd web && npm install && npm run build         # tsc -b && vite build
```

## Configure the target

- Provide env from Secret Manager / the host's env, matching `server/.env.example`:
  `MS_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, a service account
  (`GOOGLE_SA_KEY_JSON` preferred in prod), `MONGO_HOST`, `CSGE_DB`.
- Set `GOOGLE_AUTH_MODE=oauth` in prod (never `bypass`). Set `WEB_ORIGIN` to the deployed web
  origin and register matching OAuth redirect URIs.
- On boot, `server.js` connects Mongo and idempotently ensures all 9 collections + indexes.

## Run

```bash
cd server && npm start        # node dist/server.js on $PORT (default 8080)
# serve web/dist/ as static files behind the same origin (or a CDN / reverse proxy)
```

## Optional: ADK agent deploy

If the change involves the ADK reasoning-engine path, `server/scripts/adk_deploy.py` deploys
the ADK agent spec (requires the Google SDK + service-account creds). Run it only when the
ADK deployer path changed.

## Post-deploy verify

1. `GET /api/health` → `{ status: 'ok', serviceAccount: true }`.
2. Run gstack **`/qa <deployed-url>`** through Connect → Migrate → Report.
3. Optionally gstack **`/canary`** for a guarded rollout.

Report what was deployed, to where, and the health/QA result. Never force-push or deploy
without confirmation.