# Rule: AI-SDLC (CloudFuze Studio Migrate)

The canonical stage pipeline every non-trivial change in this repo follows. This is the
single source of truth for "what order do we do things in" — [CLAUDE.md](../../CLAUDE.md)'s
Recommended Workflow section is a cheat-sheet pointer to this file, not a second copy.
gstack `/review` and `/team-review` read this rule.

## The seven stages

| # | Stage | Purpose | gstack command | Project command | Gate before moving on |
|---|-------|---------|-----------------|------------------|------------------------|
| 1 | **Spec** | Turn a vague ask into a precise, testable requirement — who's affected, current vs. desired behavior, why now, done-criteria. | `/office-hours` (still exploring value/feasibility) → `/spec` (ready to lock requirements) | — | The five spec questions (who/what-is/what-should-be/why-now/how-we-know) are answered, not hand-waved. |
| 2 | **Plan** | Lock architecture before code: pipeline impact, whether `AgentIR`/DB schema changes, fidelity impact. | `/autoplan` or `/plan-eng-review` | **architect** agent | Design states pipeline impact + IR/schema delta + fidelity impact explicitly. Any `AgentIR` shape change gets a note in [decisions.md](../memory/decisions.md). |
| 3 | **Implement** | Write the code inside the locked design. | — | **`/scaffold`** for new services/routes/repos/pages; **`/feature`** or **`/bugfix`** to drive the whole loop | Follows [architecture-boundaries.md](architecture-boundaries.md) and [code-style.md](code-style.md); `npm run typecheck` clean in both `server/` and `web/`. |
| 4 | **Review** | Catch bugs and project-convention violations before they ship. | `/review` (general bugs) | **`/team-review`** (CS_GE-specific: phase boundary, fidelity honesty, `appUserId` scoping, idempotency) | Findings addressed or explicitly accepted, not silently skipped. |
| 5 | **QA** | Confirm the change works in a real browser against a running `web` + `server`. | `/qa <staging-url>` or `/qa-only` | — | Run for anything user-facing (wizard steps, SSE progress, report page). |
| 6 | **Security** | Audit secrets, OAuth/service-account scope, token logging, multi-tenant isolation. | `/cso` | — | Run whenever the change touches `auth/`, config, tokens, or a migration-scoped Mongo query. See [security-rules.md](security-rules.md). |
| 7 | **Ship** | Open the PR, meeting the project's PR bar. | `/ship` (PR) → `/land-and-deploy` (deploy/verify prod) | — | Matches [pr-standard.md](pr-standard.md)'s pre-PR checklist. |

## Two paths through the pipeline

**Full pipeline** (new feature, anything touching `AgentIR`, DB schema, or the phase
boundary): all seven stages, in order. `/feature` orchestrates this end-to-end.

**Fast path** (routine change — no architecture question, no schema change): skip Spec
and Plan, start at Implement. Still run Review → QA (if user-facing) → Security (if
security-sensitive) → Ship. `/bugfix` orchestrates this for bug fixes specifically —
Stage 1 becomes "reproduce & locate" via `/investigate` instead of a written spec.

Do not skip Review or Ship's PR checklist on either path — those two are never optional.

## Stage skip conditions

- **Skip Spec** — the ask is already unambiguous (a one-line config change, a typo fix,
  a bug with an obvious root cause).
- **Skip Plan** — no `AgentIR`/DB schema change and no cross-layer boundary crossed.
- **Skip QA** — change is not user-facing (pure backend logic covered by `vitest`).
- **Skip Security** — change touches none of: `auth/`, secrets, tokens, migration-scoped
  Mongo queries.
- **Never skip** — Review, typecheck, and the `/ship` PR checklist in
  [pr-standard.md](pr-standard.md).

## Why a named standard

Before this rule, the stage → command mapping only existed inline in `/feature` and
`/bugfix` and as a shorter cheat-sheet in CLAUDE.md's Recommended Workflow — no single
place defined the full seven-stage pipeline or its skip conditions. This file is that
place; `/feature`, `/bugfix`, and CLAUDE.md all point here instead of restating it.
