# Rule: Pull Request Standard (CloudFuze Studio Migrate)

What a PR must satisfy before it lands. gstack `/ship` opens the PR; `/review` and `/cso`
gate it. This rule is the human checklist behind those.

## Before opening a PR

- [ ] `npm run typecheck` passes in **both** `server/` and `web/` (zero errors).
- [ ] `npm run build` succeeds for anything that touched build config or web code.
- [ ] No secrets, tokens, `.env`, or `service_account.json` in the diff. No new secret-bearing
      file without a matching `.gitignore` entry.
- [ ] Every new/changed Mongo query on a migration-scoped collection filters by `appUserId`.
- [ ] Idempotency preserved on any create/upload path (re-running the migration is safe).
- [ ] Fidelity honesty preserved — lossy mappings emit `FidelityNote`s; nothing silently dropped.
- [ ] Ran gstack **`/review`**; addressed findings.
- [ ] Ran gstack **`/qa <staging-url>`** if the change is user-facing.
- [ ] Ran gstack **`/cso`** if the change touched auth, secrets, tokens, or tenant scoping.

## Commit messages

- Imperative subject ≤ 72 chars: `mapper: preserve AI Builder prompt in instruction synthesis`.
- Body explains the **why** (the codebase values this) and any fidelity/behavior impact.
- Reference the phase/stage touched (extract / map / create / verify / report) when relevant.

## PR description

Include:
- **What** changed and **why**.
- **Pipeline impact**: which stage(s), and whether `AgentIR` shape or DB schema changed.
- **Fidelity impact**: does this change what gets migrated or how it's reported? Call it out.
- **Migration safety**: is it backward-compatible with already-staged/already-migrated data?
- **Testing**: typecheck result + which `_test_*` probe or `/qa` run you used.

## Scope & size

- Keep PRs to one pipeline concern. A mapping change and a DB-schema change are two PRs.
- Diagnostic spikes (`_diag_*`, `_test_*`, `_demo_*`, `_poc_*`) should generally not ship in a
  feature PR — if one must, note it as throwaway in the description.
- Never bump lockfiles incidentally; dependency changes are their own PR with a reason.

## Do not

- Do not land with failing typecheck, unaddressed `/review` findings, or a red `/qa`.
- Do not weaken CORS, raise the body limit, add wildcard OAuth redirects, or hardcode a Gemini
  engine id to make a test pass.