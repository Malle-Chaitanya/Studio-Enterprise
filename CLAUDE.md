# CloudFuze Studio Migrate (CS_GE)

CloudFuze Studio Migrate is a production-grade tool that migrates **agents** from
**Microsoft Copilot Studio** into **Google Gemini Enterprise**. A customer connects
both clouds (Microsoft admin + Google admin), the tool extracts each Copilot agent
losslessly from Dataverse into a neutral intermediate representation (`AgentIR`),
maps it into a Gemini Discovery Engine agent, creates/publishes/shares it, verifies
it, and produces a per-agent fidelity report. Phase 1 scope is **agents only**
(high-fidelity); flows/workflows come later. The guiding principles are **lossless
extraction**, **behavioral fidelity**, and **honesty over overclaiming** — the tool
recommends, it does not silently decide.

## Prerequisites — Install gstack once on your machine

This project uses **gstack** for AI-assisted development (code review, QA, security audits, docs, deployment). Every contributor must install gstack **once** on their own machine before using Claude Code on this repo.

**Requirements:** Claude Code, Git, Node.js 18+ ([nodejs.org](https://nodejs.org) LTS). Bun is installed automatically by gstack's setup.

**Windows users:** you must use **Git Bash** (comes with Git for Windows). PowerShell and CMD will NOT work.

### Fastest install — paste this to Claude Code

Open Claude Code (from anywhere on your machine) and paste this exact message:

> Install gstack: run `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` then confirm the skills are available by listing `~/.claude/skills/`.

Claude will clone the repo, run setup, and verify. Takes ~60 seconds.

### Manual install

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack
./setup
```

### Verify it works

Reopen this project in Claude Code and type `/office-hours` — if Claude responds with the office-hours flow, gstack is working.

### Update gstack later

Inside any Claude Code session, run `/gstack-upgrade`.

### Troubleshooting

| Problem | Fix |
|---------|-----|
| `/office-hours` not recognized | `cd ~/.claude/skills/gstack && ./setup` |
| Windows: `bad interpreter: /bin/bash^M` | `cd ~/.claude/skills/gstack && git config core.autocrlf false && git config core.eol lf && git rm --cached -r . && git reset --hard HEAD && ./setup` |
| `/browse` fails | `cd ~/.claude/skills/gstack && bun install && bun run build` |

## Tech Stack

- **Server** (`server/`): Node 20+, TypeScript (ESM, `.js` import specifiers), Express 4,
  MongoDB 7 (native `mongodb` driver — no ODM), Zod validation, Pino logging,
  `google-auth-library`, `bcryptjs`, `yaml`. Dev via `tsx watch`.
- **Web** (`web/`): React 18, Vite 6, `react-router-dom` 6, TypeScript. No UI component
  library — hand-rolled CSS in `web/src/styles.css`.
- **External APIs**: Microsoft Graph + Dataverse (Power Platform), Google Discovery
  Engine `v1alpha` (Gemini Enterprise / Agentspace), Google Cloud IAM.

## Architecture Summary

Pipeline: **extract → IR → map → create → verify → report**. The orchestrator
([server/src/orchestrator.ts](server/src/orchestrator.ts)) runs two phases:

1. **EXTRACT** — Copilot Studio (Dataverse) → transform → LOAD into MongoDB `stagedAgents`.
2. **INSERT** — read staged rows → create/publish/share/verify in Gemini.

Staging in the DB decouples the phases so a failed insert run is retryable without
re-extracting. Both phases use bounded-concurrency pools. Progress streams to the
browser over **SSE** via an `EventQueue`. See [.claude/memory/architecture.md](.claude/memory/architecture.md).

## Critical Constraints

- **No secrets in git.** Credentials come from env / Secret Manager. `service_account.json`,
  `.env`, and `*sa-key*.json` are git-ignored. Never print token values in logs.
- **Idempotent & resumable.** Re-migrating must never duplicate agents or files.
  Persistence writes are best-effort — the app still runs if Mongo is down.
- **Multi-tenant.** Every migration-scoped collection is keyed by `appUserId`.
- **Lossless & honest.** Preserve everything extracted (even unmapped fields surface
  in the report). Never overclaim fidelity — record `lost` / `needs-review` truthfully.
- **Client-agnostic.** Never hardcode a Gemini engine id — always discover it from the
  connected project.

See [.claude/rules/](.claude/rules/) for the full rule set.

## Repository Navigation

| Path | What lives here |
|------|-----------------|
| [server/src/orchestrator.ts](server/src/orchestrator.ts) | Two-phase migration engine, SSE event queue, concurrency pools |
| [server/src/routes/](server/src/routes/) | Express routers: `auth`, `explore`, `destination`, `migrate` |
| [server/src/services/](server/src/services/) | Domain logic: `dataverse`, `mapper`, `gemini`, `verify`, `report`, topics/knowledge |
| [server/src/db/](server/src/db/) | Mongo `core` + `mongo` bootstrap + `repos/*` (one repo per collection) |
| [server/src/auth/](server/src/auth/) | `microsoft.ts` (Graph/Dataverse), `google.ts` (SA + DWD) |
| [server/src/types.ts](server/src/types.ts) | `AgentIR` and all shared pipeline types (start here) |
| [server/src/config.ts](server/src/config.ts) | Zod-validated env config (fail-fast) |
| [web/src/pages/](web/src/pages/) | React screens: Connect → ChoosePair → SelectMap → SelectData → Migrate |
| [web/src/api.ts](web/src/api.ts) | Typed fetch wrappers for the backend |
| [docs/](docs/) | Specs, feasibility studies, Gemini edition/visibility findings, support tickets |
| [server/src/spikes/](server/src/spikes/) | Throwaway diagnostic spikes (`_diag_*.ts`, `_test_*.ts`, etc., run via `tsx`) — NOT app code |

## Memory Files

Read these before scanning source — they hold stable, project-specific knowledge:

- [.claude/memory/project-context.md](.claude/memory/project-context.md) — business purpose, who uses it, product principles
- [.claude/memory/architecture.md](.claude/memory/architecture.md) — pipeline, DB schema, SSE, auth flows
- [.claude/memory/decisions.md](.claude/memory/decisions.md) — architectural decisions (incl. gstack command renames)
- [.claude/memory/domain-knowledge.md](.claude/memory/domain-knowledge.md) — Copilot/Dataverse & Gemini concepts, glossary
- [.claude/memory/progress.md](.claude/memory/progress.md) — current status, known limitations, next phases
- [.claude/memory/repository-map.md](.claude/memory/repository-map.md) — file-by-file map

## Environment Variables

Configure `server/.env` (copy from [server/.env.example](server/.env.example)). Required:
`MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, plus a
service account (`GOOGLE_SA_KEY_FILE` or `GOOGLE_SA_KEY_JSON`). Optional: `MONGO_HOST`
(default `mongodb://localhost:27019`), `CSGE_DB` (default `csge`), `GEMINI_PROJECT_FALLBACK`
(last-resort project fallback), `INSTRUCTION_LLM_*` (LLM instruction refinement).

## Common Commands

```bash
# Backend (from server/)
npm install && cp .env.example .env    # first-time setup, then fill in .env
npm run dev                            # tsx watch on :8080
npm run typecheck                      # tsc --noEmit — run before every commit
npm run build && npm start             # production build + run

# Frontend (from web/)
npm install
npm run dev                            # Vite on :5173
npm run typecheck
npm run build                          # tsc -b && vite build

# MongoDB (CS_GE uses its own instance on 27019 to avoid collisions)
docker run -d --name csge-mongodb --restart unless-stopped \
  -p 127.0.0.1:27019:27017 -v csge-mongo-data:/data/db mongo:7.0
```

## Available gstack Commands

gstack is installed globally at `~/.claude/skills/gstack`. Use `/browse` from gstack for all web browsing; never use `mcp__claude-in-chrome__*` tools.

- **Planning:** `/office-hours`, `/autoplan`, `/spec`, `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`
- **Review & investigate:** `/review`, `/investigate`, `/codex`
- **Testing:** `/qa <url>`, `/qa-only <url>`, `/browse`, `/open-gstack-browser`
- **Security & docs:** `/cso`, `/document-release`, `/document-generate`
- **Ship & deploy:** `/ship`, `/land-and-deploy`, `/canary`
- **Safety:** `/careful`, `/freeze`, `/guard`, `/unfreeze`
- **Learn & upgrade:** `/learn`, `/gstack-upgrade`

## Recommended Workflow

- **New feature:** `/office-hours` → `/autoplan` → implement → `/review` → `/qa` → `/cso` → `/ship`
- **Routine change:** implement → `/review` → `/qa` → `/ship`
- **Bug fix:** `/investigate` → fix → `/review` → `/qa` → `/ship`

**Before every PR (never skip):**
- `/review` — bugs CI won't catch
- `/qa <staging-url>` — real browser test
- `/cso` — security audit (if security-sensitive)
- `/ship` — opens PR

## Pre-flight — gstack availability check

Before offering the Skill routing menu OR running any gstack slash command, Claude MUST first verify gstack is installed:

```bash
test -f ~/.claude/skills/gstack/setup && echo "gstack_installed" || echo "gstack_missing"
```

- `gstack_installed` → show **Menu A** below
- `gstack_missing` → show **Menu B** below

Install command (used when the user chooses "Install gstack now"):

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
```

After install, tell the user: "✅ gstack installed. Reopen this project in Claude Code so the new skills are discovered. Then re-ask your original question."

If install fails, report the error, suggest the manual install, and fall back to the normal project approach.

## Skill routing

Before any repository task, Claude must run the Pre-flight check and show the correct menu.

**Menu A — gstack IS installed**

"Before I start, choose one:
1. Use gstack workflow
2. Use normal project files / plain Claude approach
3. Let Claude recommend the best option first"

**Menu B — gstack is NOT installed**

"gstack is not installed on your machine. Before I start, choose one:
1. Install gstack now (~60 seconds), then use gstack workflow
2. Use normal project files / plain Claude approach (no gstack workflows available)
3. Let Claude recommend the best option first"

The install option MUST appear on every question until gstack is installed — not just the first time.

**Slash command exception:** if the user types a gstack slash command (`/review`, `/qa`, `/cso`, `/ship`, `/office-hours`, etc.) directly, run the Pre-flight check first. If installed, run the command directly. If not, show Menu B.

Claude must wait for the user's selection before reading files, editing files, or invoking any skill.

**Option 1 (Menu A) — Use gstack workflow.** Mappings:
- Product brainstorm / feature ideas → `/office-hours`
- Rough idea to spec → `/spec`
- Scope tradeoffs → `/plan-ceo-review`
- New-feature architecture → `/plan-eng-review`
- Bugs / unexpected errors → `/investigate`
- Test a URL → `/qa` or `/qa-only`
- Diff review before land → `/review`
- Security-sensitive change → `/cso`
- Open a PR → `/ship`
- Deploy / verify prod → `/land-and-deploy`
- Docs update → `/document-release`
- Docs generation → `/document-generate`

**Option 1 (Menu B) — Install gstack now.** Run the install command. On success, tell the user to reopen the project. On failure, fall back to Option 2.

**Option 2 — Use normal project files / plain Claude approach.** Reading files, explaining code, small edits, typo fixes, one-file updates, basic refactoring, config changes, project Q&A, checking implementation details.

**Option 3 — Let Claude recommend.** If gstack installed → recommend between gstack workflow and normal approach. If gstack missing → recommend between installing gstack (for tasks that need it) or normal approach (for small tasks).
