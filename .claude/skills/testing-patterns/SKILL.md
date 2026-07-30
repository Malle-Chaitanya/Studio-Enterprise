---
name: testing-patterns
description: How CloudFuze Studio Migrate is tested today — the _diag_/_test_ tsx spike harness, in-pipeline verify.ts, and the idempotency / Mongo-down / fidelity assertions unique to this repo. Use when writing or running tests for CS_GE.
---

# Skill: CS_GE Testing Patterns

There is no unit-test runner wired up yet; CS_GE is tested through a **diagnostic-spike
harness** plus in-pipeline verification and gstack `/qa`. This skill teaches that specific
setup. See [.claude/rules/testing-standard.md](../../rules/testing-standard.md).

## The spike harness

`server/src/_test_*.ts` and `_diag_*.ts` are standalone scripts run with `tsx` that hit real
Dataverse/Gemini against a test tenant. They are integration probes, not isolated units.

```bash
cd server
npx tsx src/_test_pipeline.ts      # end-to-end extract→map→create
npx tsx src/_test_migrate.ts       # migration path
npx tsx src/_test_snapshot.ts      # Dataverse snapshot
npx tsx src/_diag_agent_raw.ts <args>   # inspect a single agent's raw Dataverse payload
```

When adding a probe, follow the naming: `_test_<thing>.ts` for a scenario, `_diag_<thing>.ts`
for an inspection. They import from `./services/*` and `./config.js`, read creds from `.env`,
and are never imported by `server.ts`.

## In-pipeline verification

`services/verify.ts` smoke-tests each migrated agent and sets `MigrationResult.verified`. When
changing the create path, confirm `verify` still runs and its result is surfaced.

## CS_GE-specific assertions (the ones that catch real regressions)

1. **Idempotency** — run the same scope twice; assert **zero** new agents / `agentFiles` on the
   second run (keyed on display name / filename).
2. **Mongo-down degradation** — stop Mongo, run a migration; assert it still completes with
   in-memory session fallback and warns (no crash, no unhandled rejection).
3. **Fidelity surfacing** — feed an agent with a lossy component; assert a `FidelityNote`
   (`lost` / `needs-review`) appears rather than silent success.
4. **Tenant scoping** — assert repo reads/writes are filtered by `appUserId`.
5. **Quota resilience** — simulate `429`/`503` from Gemini; assert backoff/retry, not failure.

## Browser flow

Use gstack **`/qa <url>`** against a running `web` (:5173) + `server` (:8080) through
Connect → ChoosePair → SelectMap → SelectData → Migrate → Report. Don't hand-roll browser tests.

## If you add a real runner

Prefer `vitest`. Unit-test the pure transforms first (`mapper`, `topicCompiler`,
`knowledgeClassifier`, `scope`) with mocked `services/*`; keep the `_test_*` probes for live
coverage.