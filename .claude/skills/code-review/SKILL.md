---
name: code-review
description: CloudFuze Studio Migrate's project-specific review conventions — the phase boundary, fidelity honesty, idempotency, appUserId scoping, and ESM/best-effort idioms that gstack /review does not know. Use when reviewing CS_GE server/web changes.
---

# Skill: CS_GE Code Review Conventions

This teaches Claude how **this codebase** wants review — not general review wisdom (gstack
`/review` covers that). Apply on top of `/review`, not instead of it.

## What matters most here, in order

1. **Phase boundary intact.** Extraction (`services/dataverse*`) must not call Gemini;
   Gemini writes (`services/gemini*`, `adkDeployer`) must not call Dataverse. The only handoff
   is the `stagedAgents` DB. A crossed boundary is a blocker even if it "works".
2. **Fidelity honesty.** Any mapping that loses or guesses at agent behavior MUST push a
   `FidelityNote` (`lost` / `needs-review`). Reject changes that make the report look better by
   hiding a loss. Unmapped fields belong on `AgentIR.unmapped`, not deleted.
3. **Tenant isolation.** Flag any query on `migrationSessions`, `migrationRuns`,
   `migrationResults`, `agentIRCache`, `environmentsCache`, `migrationLogs`, or `stagedAgents`
   that doesn't filter by `appUserId`.
4. **Idempotency.** Create/upload paths must be safe to re-run — keyed on display name /
   filename. New duplicate-producing logic is a blocker.
5. **Best-effort persistence.** Repo writes must guard on `isDbConnected()` and never throw;
   the app runs without Mongo.

## Idioms to enforce

- ESM `.js` specifiers in server relative imports; `import type` for type-only imports.
- Errors returned as `{ error: '<snake_case>', detail? }`; early-return `void` guards.
- SSE events are members of the `ProgressEvent` union — no ad-hoc event shapes.
- Bounded-concurrency pool + backoff for external fan-out; never raw `Promise.all` at
  Dataverse/Discovery Engine.
- Pino `logger` only; no `console.log`. Never log tokens/secrets.
- No hardcoded Gemini engine id — destination is discovered.

## Things NOT to flag

- The single `console.error` in `config.ts` (deliberate fail-fast).
- Heavy "why" comments (they are the house style — keep them).
- `_diag_*` / `_test_*` / `_demo_*` / `_poc_*` spikes — throwaway, exempt from app rules.

## Output

Group findings blocker → major → minor. For each: `file:line — issue — which rule
([.claude/rules/…]) — fix`. Finish with a **ship / fix-first / needs-design** verdict.