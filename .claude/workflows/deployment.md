# Workflow: Deployment (CloudFuze Studio Migrate)

Ship a build to staging/prod. gstack **`/land-and-deploy`** orchestrates the general
land-verify-prod flow; the **/deploy** command carries the CS_GE-specific steps it needs. Run the
CLAUDE.md **Pre-flight** check first.

1. **Pre-deploy gates**
   - `cd server && npm run typecheck` and `cd web && npm run typecheck` — clean.
   - No secrets in the artifact (`.env`, `service_account.json`, `*sa-key*.json` stay out; prod
     uses **Secret Manager**).
   - Target Mongo reachable (CS_GE's **own** instance, default `:27019`, db `csge`).
2. **Build both apps** (see [.claude/commands/deploy.md](../commands/deploy.md))
   ```bash
   cd server && npm install && npm run build      # → server/dist
   cd web    && npm install && npm run build      # → web/dist
   ```
3. **Configure the target** — env from Secret Manager matching `server/.env.example`;
   `GOOGLE_AUTH_MODE=oauth` (never `bypass` in prod); `WEB_ORIGIN` set to the deployed origin with
   matching OAuth redirect URIs. On boot the server ensures all 9 collections + indexes.
4. **Optional ADK deploy** — if the ADK reasoning-engine path changed, run
   `server/scripts/adk_deploy.py` (needs the Google SDK + SA creds).
5. **`/land-and-deploy`** — gstack orchestration for the PR-to-prod flow.
6. **Verify**
   - `GET /api/health` → `{ status:'ok', serviceAccount:true }`.
   - **`/qa <deployed-url>`** through Connect → Migrate → Report.
   - Optionally **`/canary`** for a guarded rollout.
7. **Docs** — **`/document-release`** for release notes; mirror any durable finding into `docs/`
   and, if it's a decision, [.claude/memory/decisions.md](../memory/decisions.md).

Never deploy or force-push without confirmation. If a gate fails, stop and report — do not weaken
CORS, scopes, or hardcode an engine id to get a green deploy.