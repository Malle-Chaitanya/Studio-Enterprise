# Workflow: Code Review (CloudFuze Studio Migrate)

Two layers: gstack finds general bugs; the project layer enforces CS_GE conventions. Run the
CLAUDE.md **Pre-flight** check first. Never skip the gstack layer.

1. **`/review`** — gstack's general code review over the working diff. Address its findings
   (logic bugs, edge cases, races, resource leaks) first.
2. **/team-review** — the CS_GE project checklist
   ([.claude/commands/team-review.md](../commands/team-review.md)), or invoke the **code-reviewer**
   agent with the **code-review** skill
   ([.claude/skills/code-review/SKILL.md](../skills/code-review/SKILL.md)). Confirm, in order:
   - **Phase boundary** — extraction doesn't call Gemini; Gemini-writes don't call Dataverse.
   - **Fidelity honesty** — lossy mappings emit `FidelityNote`s; nothing dropped/overclaimed.
   - **Tenant isolation** — every migration-scoped query filters by `appUserId`.
   - **Idempotency** — create/upload safe to re-run.
   - **Best-effort persistence** — repo writes guard `isDbConnected()`, never throw.
   - **API shape** — errors `{ error:'<snake_case>', detail? }`; SSE events in the `ProgressEvent` union.
   - **Style** — ESM `.js` specifiers, `import type`, Pino `logger`, no hardcoded engine id.
3. **Security pass** — if the diff touched auth/secrets/tokens/tenant scope, run **`/cso`** and the
   **security-reviewer** agent.
4. **Verdict** — produce a **ship / fix-first / needs-design** call with findings grouped
   blocker → major → minor, each as `file:line — issue — rule — fix`.

Do **not** flag: the `console.error` in `config.ts`, the dense "why" comments, or the `_diag_*`/
`_test_*` spikes (throwaway, exempt).