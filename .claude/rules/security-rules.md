# Rule: Security (CloudFuze Studio Migrate)

This tool holds two clouds' admin credentials for multiple customers. Security is not
optional. gstack `/cso` runs the general audit; these are the CS_GE-specific invariants.

## Secrets

- **Never commit secrets.** `.env`, `service_account.json`, `*sa-key*.json`,
  `*service-account*.json`, `secrets/`, `migration_data/` are git-ignored — keep them that
  way. New secret-bearing files must be added to `.gitignore` in the same change.
- All config comes from the environment via [server/src/config.ts](../../server/src/config.ts)
  (Zod-validated, fail-fast). In production these come from **Secret Manager**, not a file.
- **Never log token values, secrets, or full auth headers.** Log the *fact* of an auth event
  and the identity/email, never the bearer token. The orchestrator's log-mirroring deliberately
  strips non-ASCII — it must never start echoing credentials.

## OAuth & service account

- Two Google paths, both least-privilege:
  - **Direct IAM** (production) — the customer grants our SA a Discovery Engine role on *their*
    project. Tried first, no impersonation.
  - **Domain-Wide Delegation** — the SA impersonates the customer admin only when authorized.
  - There is no dev bypass: the customer admin always signs in via real OAuth. Do not
    reintroduce a fixed-impersonation shortcut that skips sign-in.
- Request the **minimum scopes**. Microsoft uses app-only `client_credentials` for Dataverse
  extraction (no delegated Dynamics consent — that triggers `AADSTS65001`). Do not add
  delegated resource scopes to the interactive sign-in.
- Redirect URIs must exactly match the registered app; do not add wildcard/localhost redirects
  to production configs.

## Multi-tenant isolation

- **Every** query against a migration-scoped collection MUST filter by `appUserId`
  (`migrationSessions`, `migrationRuns`, `migrationResults`, `agentIRCache`, `environmentsCache`,
  `migrationLogs`, `stagedAgents`). A query missing `appUserId` is a cross-tenant leak — block it.
- Session ids are opaque and server-side only, with a Mongo TTL. Never trust a client-supplied
  `appUserId`; derive it from the authenticated session.

## Input & transport

- Validate request bodies (Zod/typed cast + guards) before use. Body size is capped
  (`express.json({ limit: '2mb' })`) — don't raise it without reason.
- CORS is pinned to `config.WEB_ORIGIN` with credentials — do not switch to `origin: true`.
- Passwords are bcrypt-hashed (`appUsers`). Never store or compare plaintext.

## Handling customer data

- Extracted `AgentIR` and results are customer data. Store them scoped by `appUserId`; do not
  copy them into logs, diagnostic dumps committed to git, or shared fixtures.
- The fidelity report must be **honest**: report what was lost or needs review. Overclaiming a
  successful migration is a trust/security failure, not just a UX one.