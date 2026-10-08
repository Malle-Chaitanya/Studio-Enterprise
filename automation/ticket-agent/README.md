# ticket-agent

Polls SprintBoard for tickets assigned to you that describe CS_GE work, spawns
a headless Claude Code session to implement a fix in an isolated worktree,
verifies it (typecheck + tests), opens a PR, and updates the ticket. It never
merges or deploys - that step stays manual on purpose.

## Setup

```bash
cd automation/ticket-agent
npm install
cp .env.example .env
```

Fill in `.env`:
- `SPRINTBOARD_TOKEN` - current session bearer token (DevTools Network tab,
  Authorization header on any `/api/*` request). No PAT exists for this tool,
  so this will need re-pasting whenever the poller starts logging 401s.
- `REPO_PATH` - point this at the isolated worktree
  (`../../../Studio-Enterprise-agent` from here, or wherever you put it) -
  **never** your interactive checkout.

## Before running unattended

1. Verify the Claude CLI invocation directly: `claude -p "say hi"` from inside
   the worktree. This tool's exact flags weren't tested end-to-end in the
   session that built it.
2. Decide on `CLAUDE_SKIP_PERMISSIONS` deliberately - left unset, the spawned
   session will hang waiting for permission prompts nobody's there to answer.
   Setting it to `1` means the session runs unattended with no per-action
   approval, which is a real decision, not a default.
3. Confirm `gh` is authenticated with push access in the worktree
   (`gh auth status`).
4. Confirm `GET /api/my-issues` actually returns an array shaped like
   `src/types.ts`'s `Issue` - that shape was inferred from the single-issue
   endpoint, not observed directly.

## Run

```bash
npm start
```

## What it does per tick

1. `GET /api/my-issues`, filtered to: assigned to you, status `To Do`,
   title/description mentions this project (Copilot Studio / Gemini
   Enterprise / AgentIR), and not already processed (`state.json`).
2. Classifies epic/story or schema-ish tickets as "full pipeline" (told to
   use gstack `/autoplan`), everything else as "fast path" (implement
   directly) - mirrors `.claude/rules/aisdlc.md`'s existing skip conditions.
3. Spawns `claude -p` in the worktree with that instruction.
4. Runs `npm run typecheck` + `npm test` in `server/` and `typecheck` in
   `web/`. Failure here means the ticket goes to `Blocked` with a comment
   explaining what broke - no PR opens on a red build.
5. On success: branches as `agent/<key>-fix`, commits, pushes, opens a PR
   against `main`, sets the ticket's `fix_description`, moves status to
   `In Review`, and comments the PR link.
6. Stops there. You review and merge the PR yourself; the existing
   `deploy.yml` handles deploy exactly as it does for any other merge.
