# Rule: Testing Standard (CloudFuze Studio Migrate)

Testing runs on three levels: **vitest** for the pure transforms, a
**diagnostic-script harness** for anything that needs a live tenant, and gstack `/qa` for
the browser flow.

## Current reality

- **`npm test` runs vitest** (`vitest run`, config in `server/vitest.config.ts`). 41 suites,
  461 tests as of 2026-08-26 — `operationBinding`, `aclDisclosure`, `sharePointUrlRecovery`,
  `connectorValidator`, `connectorCredentials`, `confluenceRouting`, `explore` and others.
  Co-locate new ones as `*.test.ts` next to the module. This rule previously said no runner
  existed; that was stale and cost a review cycle rediscovering it.
- Verification of a live migration happens in-pipeline via
  [server/src/services/verify.ts](../../server/src/services/verify.ts), which smoke-tests each
  migrated Gemini agent and records the result on `MigrationResult.verified`.
- Ad-hoc and integration testing uses the `_test_*.ts` / `_diag_*.ts` spike scripts in
  `server/src/spikes/`, run with `tsx`, e.g.:
  ```bash
  cd server && npx tsx src/spikes/_test_pipeline.ts
  cd server && npx tsx src/spikes/_test_migrate.ts
  ```
  These exercise real Dataverse/Gemini calls against a test tenant — they are integration
  probes, not isolated unit tests.

## Standards

- **Typecheck is mandatory.** `npm run typecheck` (both `server/` and `web/`) must pass with
  zero errors before any change is considered testable-done.
- **Idempotency is testable behavior.** Any change to the create/upload path must be verified
  to be safely repeatable: run the migration twice against the same scope and confirm no
  duplicate agents or `agentFiles` are created (the code keys on display name / filename).
- **Best-effort persistence must degrade, not crash.** Test with Mongo stopped: the app must
  still boot and run a migration (in-memory session fallback, warnings logged).
- **Fidelity is asserted, not assumed.** When testing a mapping change, assert that lost or
  heuristic mappings surface as `FidelityNote`s (`lost` / `needs-review`) — never let a
  regression silently drop agent behavior.
- **Browser flow** (Connect → ChoosePair → SelectMap → SelectData → Migrate → Report) is
  tested with gstack **`/qa <url>`** against a running `web` + `server`, not by hand-written
  Selenium.

## When adding a real test runner

- Prefer `vitest` (matches the Vite/TS toolchain). Co-locate as `*.test.ts`.
- Unit-test the pure transforms first: `mapper.ts`, `topicCompiler.ts`, `knowledgeClassifier.ts`,
  `scope.ts` — they take data in and give data out, no network.
- Mock external APIs at the `services/*` boundary; never hit live Dataverse/Gemini in unit tests.
- Keep the `_test_*.ts` integration probes — they cover what mocks can't.