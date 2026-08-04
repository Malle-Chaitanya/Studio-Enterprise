# AGENTS.md — Agent roster & handoffs (CloudFuze Studio Migrate)

This file defines the project-specific subagents in [.claude/agents/](.claude/agents/),
how they hand off to each other, and where **gstack** replaces an agent's job.

> **Division of labor with gstack.** gstack owns *generic* engineering workflows
> (code review, QA, security audit, ship). The agents below own *this project's*
> domain: the extract→map→create→verify pipeline, `AgentIR` fidelity, the Discovery
> Engine API, Dataverse extraction, and multi-tenant Mongo persistence. When a task
> is generic, prefer the gstack command; when it needs knowledge of CS_GE's
> conventions, use the agent.

## Roster

| Agent | File | Owns | gstack overlap |
|-------|------|------|----------------|
| **Architect** | [architect.md](.claude/agents/architect.md) | Designs pipeline changes before code; guards phase boundaries & `AgentIR` shape | Complements `/plan-eng-review` — the agent knows CS_GE's extract→map→create stages |
| **Code Reviewer** | [code-reviewer.md](.claude/agents/code-reviewer.md) | Reviews against CS_GE rules (ESM `.js` specifiers, best-effort persistence, idempotency) | gstack `/review` finds general bugs; this agent enforces project conventions |
| **Security Reviewer** | [security-reviewer.md](.claude/agents/security-reviewer.md) | Secret handling, OAuth/DWD scopes, token logging, tenant isolation | gstack `/cso` runs the general audit; this agent knows our auth model |
| **Test Writer** | [test-writer.md](.claude/agents/test-writer.md) | Writes tests/spikes for the pipeline; extends the `_test_*.ts` harness pattern | gstack `/qa` browser-tests the UI; this agent covers server logic |
| **Researcher** | [researcher.md](.claude/agents/researcher.md) | Investigates Discovery Engine / Dataverse API behavior, quotas, edition limits | Complements `/investigate` with domain docs in `docs/` |

## Handoff process

1. **Architect first** for any non-trivial pipeline change. It produces a short design
   (Summary → Architecture → Implementation Sequence → Notes) and hands the sequence to
   whoever implements. It does **not** write app code.
2. **Implementer** (you, or a gstack workflow) writes code following the design and
   [.claude/rules/](.claude/rules/).
3. **Code Reviewer** checks project conventions; run gstack **`/review`** for general bugs.
4. **Security Reviewer** runs whenever auth, secrets, tokens, or tenant scoping changed;
   run gstack **`/cso`** for security-sensitive PRs.
5. **Test Writer** adds/updates coverage; run gstack **`/qa <url>`** for the browser flow.
6. **Ship** via gstack **`/ship`**.

## Escalation rules

- **Fidelity risk** (a mapping could silently lose agent behavior) → Architect + Code
  Reviewer must both sign off; the loss must be recorded as a `FidelityNote`
  (`lost` / `needs-review`), never hidden.
- **Secret or token exposure** → stop, escalate to Security Reviewer, do not commit.
- **Cross-tenant data leak risk** (a query missing `appUserId`) → Security Reviewer blocks.
- **External API contract change** (Discovery Engine / Graph) → Researcher confirms
  against live docs before code changes land.

## Ownership boundaries

- Agents never bypass the **phase boundary**: extraction code stays in `services/dataverse.ts`
  + the EXTRACT phase; Gemini writes stay in `services/gemini.ts` + the INSERT phase.
- Agents never introduce an ODM or hardcode a Gemini engine id.
- Diagnostic scripts (`_diag_*`, `_test_*`, `_demo_*`, `_poc_*`) are the Researcher's and
  Test Writer's sandbox — they are not shipped app code and are exempt from app rules.
- Code review is handled by gstack `/review`; the `code-reviewer` agent handles
  project-specific conventions gstack doesn't know. The same split applies to
  security (`/cso` vs `security-reviewer`) and QA (`/qa` vs `test-writer`).
