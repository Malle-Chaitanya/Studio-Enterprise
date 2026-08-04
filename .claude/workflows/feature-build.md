# Workflow: Feature Build (CloudFuze Studio Migrate)

Repeatable path for adding a feature to the extract→map→create→verify→report pipeline. Generic
steps run through **gstack**; project-specific steps use this repo's rules/agents. Run the CLAUDE.md
**Pre-flight** check first — if gstack is missing, install it or fall back to the plain approach.

1. **`/office-hours`** — clarify the problem, users, and success criteria. Identify which pipeline
   stage(s) the feature touches.
2. **`/autoplan`** (CEO + eng + design review) — or the **architect** agent for a CS_GE design.
   The design must state: pipeline impact, whether `AgentIR`/DB schema changes, and fidelity impact.
3. **Implement** following [.claude/rules/architecture-boundaries.md](../rules/architecture-boundaries.md):
   keep the two phases separate, scope every query by `appUserId`, keep create/upload idempotent,
   emit `FidelityNote`s for any lossy mapping. Use the **/scaffold** command for new
   services/routes/repos/pages. No hardcoded engine id.
4. Run `npm run typecheck` in `server/` and `web/` — zero errors.
5. **`/review`** — gstack code review, then **/team-review** for CS_GE conventions
   ([.claude/skills/code-review/SKILL.md](../skills/code-review/SKILL.md)).
6. **`/qa <staging-url>`** — real browser test through the affected wizard steps.
7. **`/cso`** — security audit (only if the change is security-sensitive: auth, secrets, tokens,
   tenant scope). Otherwise skip.
8. **`/ship`** — open the PR, meeting [.claude/rules/pr-standard.md](../rules/pr-standard.md).

**Record** any architectural decision (IR shape, new collection, phase change) in
[.claude/memory/decisions.md](../memory/decisions.md).