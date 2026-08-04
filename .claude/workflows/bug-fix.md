# Workflow: Bug Fix (CloudFuze Studio Migrate)

Path for fixing a defect — most CS_GE bugs are extraction/migration/quota/fidelity/auth issues.
Run the CLAUDE.md **Pre-flight** check first.

1. **`/investigate`** — gstack systematic diagnosis. Or reproduce directly and locate by bucket:
   - extraction wrong/empty → `services/dataverse.ts`, `AgentIR`, a `ComponentType`
   - migration fails in Gemini → `services/gemini.ts`/`geminiAgentFiles.ts`, quota backoff, auth
   - fidelity off → `services/mapper.ts`/`topicCompiler.ts` (`FidelityNote` honesty)
   - nothing persists / duplicates → `db/repos/*`, `isDbConnected()`, idempotency keys, `appUserId`
   - auth/connect fails → `auth/*`, `routes/auth.ts`, `AADSTS*`, redirect URIs, `GOOGLE_AUTH_MODE`
   - UI stuck → `web/src/pages/*`, SSE handling in `web/src/api.ts`
   (see [.claude/memory/domain-knowledge.md](../memory/domain-knowledge.md).)
2. **Reproduce** with the relevant `_diag_*`/`_test_*` spike or a `/qa` run. Confirm the root cause.
3. **Fix** the root cause, not the symptom. Preserve idempotency, best-effort persistence, tenant
   scoping, and fidelity honesty. A silent fidelity loss must be made to **surface** as a
   `FidelityNote`.
4. **Verify**: `npm run typecheck`; re-run the reproducer; for idempotency fixes run the migration
   twice (no duplicates); for Mongo-related fixes test with Mongo stopped (graceful degradation).
5. **`/review`** → **/team-review** — confirm the fix respects CS_GE conventions.
6. **`/qa <staging-url>`** — if user-facing.
7. **`/cso`** — if the fix touched auth/secrets/tokens/tenant scope.
8. **`/ship`** — open the PR; commit message explains the root cause and the *why*.