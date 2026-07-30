---
description: CloudFuze Studio Migrate project-specific review checklist (renamed from review.md to avoid gstack /review collision)
---

# /team-review — CS_GE project review checklist

> **Naming:** this command is `team-review`, **not** `review` — `/review` is reserved by
> gstack. For general bug-finding run gstack **`/review`** first; then run `/team-review`
> for the CloudFuze-specific conventions gstack doesn't know.

Review the current diff (or the file/area named in `$ARGUMENTS`) against **this project's**
rules. Report findings grouped by severity. Do not fix silently — list, then fix on request.

## Checklist

**Architecture & phases** ([rules/architecture-boundaries.md](../rules/architecture-boundaries.md))
- [ ] Extraction code doesn't call Gemini; Gemini-write code doesn't call Dataverse. Handoff
      stays through the `stagedAgents` DB.
- [ ] Dependencies point down (routes → orchestrator → services → repos → db). No upward imports.
- [ ] No hardcoded Gemini engine/app id — destination is discovered at runtime.
- [ ] `AgentIR` changes are intentional and noted in [decisions.md](../memory/decisions.md).

**Fidelity & honesty** ([memory/project-context.md](../memory/project-context.md))
- [ ] Lossy/heuristic mappings emit `FidelityNote`s (`lost` / `needs-review`). Nothing dropped
      silently. Unmapped fields ride on `AgentIR.unmapped`.
- [ ] The report doesn't overclaim success.

**Persistence & multi-tenancy** ([rules/security-rules.md](../rules/security-rules.md))
- [ ] Every migration-scoped query filters by `appUserId`.
- [ ] New repo writes are best-effort (`isDbConnected()` guard, never throw).
- [ ] Idempotent: re-running the migration creates no duplicate agents/files.

**API conventions** ([rules/api-conventions.md](../rules/api-conventions.md))
- [ ] Errors returned as `{ error: '<snake_case>', detail? }` with the right status.
- [ ] New SSE events added to the `ProgressEvent` union, not ad-hoc shapes.

**Code style** ([rules/code-style.md](../rules/code-style.md))
- [ ] ESM `.js` specifiers in server relative imports; `import type` for types.
- [ ] No `console.log` in app code; uses the Pino `logger`.
- [ ] Explanatory "why" comments preserved.

**Security** ([rules/security-rules.md](../rules/security-rules.md))
- [ ] No secrets/tokens in the diff or logs. New secret files are git-ignored.
- [ ] Least-privilege scopes; `bypass` mode not enabled against real projects.

## Output format

For each finding: `severity (blocker/major/minor) — file:line — what — why it matters — suggested fix`.
End with a one-line verdict: **ship / fix-first / needs-design**.