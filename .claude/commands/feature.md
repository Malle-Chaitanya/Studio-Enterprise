---
description: Drive a new CS_GE feature end-to-end through the project pipeline, delegating generic steps to gstack.
---

# /feature — build a CS_GE feature

Take the feature described in `$ARGUMENTS` from idea to PR, respecting the extract→map→create→
verify→report pipeline. This command orchestrates project steps and hands generic work to gstack.

## Flow

1. **Clarify** — if the feature is fuzzy, run gstack **`/office-hours`** to pin down the problem
   and success criteria. Identify which pipeline stage(s) it touches.
2. **Design** — run the **architect** agent (or gstack **`/autoplan`** / **`/plan-eng-review`**)
   to produce a design. It must state: pipeline impact, whether `AgentIR`/DB schema changes,
   and fidelity impact. No code before this is agreed.
3. **Implement** — follow [.claude/rules/architecture-boundaries.md](../rules/architecture-boundaries.md).
   Use **/scaffold** for new services/routes/repos/pages. Keep the two phases separate; scope
   every query by `appUserId`; keep it idempotent; emit `FidelityNote`s for any lossy mapping.
4. **Typecheck** — `npm run typecheck` in `server/` and `web/`; zero errors.
5. **Review** — gstack **`/review`** for general bugs, then **/team-review** for CS_GE rules.
6. **QA** — gstack **`/qa <staging-url>`** through the affected wizard steps.
7. **Security** — gstack **`/cso`** if the feature touched auth, secrets, tokens, or tenant scope.
8. **Ship** — gstack **`/ship`** to open the PR, meeting [pr-standard.md](../rules/pr-standard.md).

## Guardrails

- Never widen scopes, weaken CORS, or hardcode an engine id to ship faster.
- If the feature could lose agent behavior, stop and get architect + code-reviewer sign-off;
  the loss must be reported, not hidden.
- Record any architectural decision (IR shape, new collection, phase change) in
  [.claude/memory/decisions.md](../memory/decisions.md).