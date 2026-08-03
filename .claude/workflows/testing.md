# Workflow: Testing (CloudFuze Studio Migrate)

How to test a change given CS_GE has no unit-test runner yet — a spike harness + in-pipeline
verify + gstack `/qa`. See [.claude/skills/testing-patterns/SKILL.md](../skills/testing-patterns/SKILL.md)
and [.claude/rules/testing-standard.md](../rules/testing-standard.md).

1. **Typecheck gate** — `cd server && npm run typecheck` and `cd web && npm run typecheck`. Zero
   errors is the baseline definition of "testable".
2. **Server logic** — use / extend the tsx spike harness (the **test-writer** agent can author
   these):
   ```bash
   cd server
   npx tsx src/spikes/_test_pipeline.ts     # extract→map→create
   npx tsx src/spikes/_test_migrate.ts      # migration path
   npx tsx src/spikes/_diag_<thing>.ts <args>   # targeted inspection
   ```
3. **CS_GE assertions** (the regressions that actually happen):
   - **Idempotency** — run the same scope twice; assert no duplicate agents/`agentFiles`.
   - **Mongo-down** — stop Mongo; assert the migration still completes (fallback + warnings).
   - **Fidelity surfacing** — a lossy component yields a `FidelityNote`, not silent success.
   - **Tenant scoping** — reads/writes filter by `appUserId`.
   - **Quota resilience** — `429`/`503` triggers backoff, not failure.
4. **In-pipeline verification** — confirm `services/verify.ts` still runs and surfaces
   `MigrationResult.verified`.
5. **Browser flow** — **`/qa <url>`** (gstack) against running `web` (:5173) + `server` (:8080),
   through Connect → ChoosePair → SelectMap → SelectData → Migrate → Report. Use **`/qa-only`** to
   re-test without re-navigating.
6. **Report** the exact commands/URLs used and their results — never claim a pass you didn't run.

**Adding a real runner?** Prefer `vitest`; unit-test the pure transforms (`mapper`,
`topicCompiler`, `knowledgeClassifier`, `scope`) with mocked `services/*`; keep the `_test_*`
probes for live coverage.