---
description: Diagnose and fix a CS_GE bug (often a migration/extraction/quota/fidelity issue), then verify and ship.
---

# /bugfix — fix a CS_GE bug

Fix the bug in `$ARGUMENTS`. Most CS_GE bugs fall into a few buckets — check which one first.

## 1. Reproduce & locate

- Run gstack **`/investigate`** for a systematic diagnosis, or reproduce directly.
- CS_GE bug buckets and where to look:
  - **Extraction wrong/empty** → `services/dataverse.ts`, the `AgentIR` shape, a specific
    `ComponentType`. Use a `_diag_*.ts` spike (e.g. `_diag_agent_raw.ts`) against a test tenant.
  - **Migration fails in Gemini** → `services/gemini.ts` / `geminiAgentFiles.ts`; check quota
    backoff (`429`/`503`), destination resolution, and IAM/DWD auth.
  - **Fidelity looks off** → `services/mapper.ts` / `topicCompiler.ts`; confirm `FidelityNote`s
    are honest.
  - **Nothing persists / duplicates on re-run** → `db/repos/*`, `isDbConnected()` guards,
    idempotency keys (display name / filename), `appUserId` scoping.
  - **Auth/connect fails** → `auth/microsoft.ts` (`AADSTS…` codes), `auth/google.ts`,
    `routes/auth.ts`, redirect URIs, `GOOGLE_AUTH_MODE`.
  - **UI wizard stuck** → `web/src/pages/*`, SSE stream handling in `web/src/api.ts`.

## 2. Fix

- Smallest change that addresses the **root cause**, not the symptom. Preserve idempotency,
  best-effort persistence, tenant scoping, and fidelity honesty.
- If the bug was a silent fidelity loss, the fix must make it **surface** as a `FidelityNote`.

## 3. Verify

- `npm run typecheck` (both packages).
- Re-run the reproducer / relevant `_test_*.ts` probe.
- For an idempotency fix, run the migration **twice** and confirm no duplicates.
- If Mongo-related, test with Mongo **stopped** to confirm graceful degradation.

## 4. Review & ship

- gstack **`/review`** → **/team-review** → gstack **`/qa`** (if user-facing) → **`/cso`** (if
  auth/secrets) → **`/ship`**.

Write a commit message that explains the root cause and the *why* of the fix.