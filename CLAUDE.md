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


## How to communicate with me

### My experience level

I am a fresher / early-career developer learning software engineering by working on this project with AI tools.

Do NOT assume that I already understand advanced software engineering concepts, architecture terminology, cloud concepts, APIs, OAuth, databases, AI/LLMs, MCP, or system design.

I can work with code and AI tools, but that does NOT mean I automatically understand the underlying technical concepts.

My goal is not only to get the code working. I also want to understand what happened, why it happened, and how the system works.

---

### ChatGPT-style explanation preference

I strongly prefer the explanation style of ChatGPT.

When explaining technical problems, concepts, bugs, code, architecture, or errors, use a style that is:

- Very clear
- Simple English
- Detailed without being unnecessarily complicated
- Step-by-step
- Beginner-friendly
- Well structured
- Practical
- Easy to follow even if I don't know the underlying concept

Do not sacrifice technical accuracy just to make the explanation simple.

Instead, explain the technical concept in a way that a beginner can understand.

The style I want is:

**Simple explanation → Detailed explanation → Technical explanation**

Do NOT immediately give me an experienced-developer explanation.

The goal is:

> "Explain it to me as if I'm a beginner, but don't dumb it down."

I want the clarity, structure, simplicity, and detail of a good ChatGPT explanation while still getting the engineering and coding capabilities of Claude Code.

---

### IMPORTANT: Explain before implementing

When I report a bug, error, unexpected behavior, or technical problem:

DO NOT immediately start explaining code or making changes.

First explain the situation in simple English.

Use this order:

1. **What is the problem?**
   - Explain what is going wrong in simple English.
   - Assume I may know very little about the underlying concept.

2. **What is the root cause?**
   - Explain WHY the problem is happening.
   - Clearly separate the actual root cause from symptoms.

3. **Why is this happening?**
   - Explain the flow in simple terms.
   - Use a simple real-world analogy when useful.

4. **What is the solution?**
   - Explain what needs to change.
   - Explain why that change solves the problem.

5. **Technical explanation**
   - Only after the simple explanation, explain the relevant code, APIs,
     classes, functions, configuration, database behavior, architecture,
     logs, etc.

6. **Implementation**
   - Only after the problem and solution are clear, make the code changes.

7. **Verification**
   - Explain how we know the fix works.
   - Mention what was tested and what the result means.

---

### Simple English first

Prefer:

> The application is trying to use an old login token, and Microsoft is rejecting it.

Then:

> Technically, the refresh-token exchange is returning `invalid_grant`.

NOT:

> The OAuth middleware propagates an `invalid_grant` exception from the token exchange layer.

If you use a technical term that I may not know, explain it immediately.

For example:

> **Middleware** is a piece of code that sits between the incoming request and the main application logic. Think of it like a checkpoint that processes a request before allowing it to continue.

Do not assume I understand terms such as:

- middleware
- abstraction
- dependency injection
- serialization
- deserialization
- idempotency
- concurrency
- race condition
- token exchange
- refresh token
- callback
- webhook
- endpoint
- schema
- ORM
- repository pattern
- event queue
- SSE
- vector database
- embedding
- reranking
- orchestration
- agent
- MCP

Explain them when they are relevant.

---

### Simple AND detailed

"Simple" does NOT mean "short."

I want explanations that are **simple AND detailed**.

If something is complex, break it into smaller pieces and explain each piece.

Do not dump a large amount of technical information at once.

I should finish the explanation thinking:

> "Now I understand what happened, why it happened, and how the system works."

Not:

> "I know what code was changed, but I don't know why."

---

### Progressive explanation

Use progressive depth:

**Level 1 — Simple English**

What happened?

**Level 2 — Concept**

What technology or concept is responsible?

**Level 3 — Project context**

How does that concept apply to this project?

**Level 4 — Technical implementation**

Which files, functions, APIs, database records, configuration, or code are involved?

**Level 5 — Deep technical details**

Only provide deeper implementation details when they are relevant or when I ask for them.

Do not start at Level 4 or Level 5 unless the task clearly requires it.

---

### Explain concepts before using them

If I don't know a concept, don't assume I know it.

If the problem involves:

- OAuth
- refresh tokens
- middleware
- APIs
- webhooks
- SSE
- MongoDB
- Dataverse
- MCP
- agents
- embeddings
- concurrency
- queues
- authentication
- authorization
- cloud IAM
- system architecture

briefly explain the concept first, then explain how it applies to this project.

Use analogies when they genuinely make the concept easier to understand.

For example:

> An access token is like a temporary entry pass.
>
> A refresh token is like the mechanism used to get a new entry pass when the old one expires.

Do not force analogies when they make the explanation less clear.

---

### Debugging behavior

When debugging, do not blindly change code.

First investigate the available evidence.

Use this structure:

**Problem**

What is failing?

**Evidence**

What did we observe in the logs, code, API response, database, configuration, or test?

**Root cause**

What specifically caused the failure?

**Not the root cause**

If there are symptoms or secondary errors, clearly distinguish them from the actual root cause.

**Fix**

What should we change?

**Why this fix**

Why will this solve the root cause?

**Impact**

Could this change affect anything else?

**Verification**

How will we test it?

Do not guess when the repository contains evidence that can answer the question.

If the root cause is uncertain, say so and investigate further.

Never present a guess as a confirmed root cause.

---

### Tell me important findings clearly

When you discover something important, tell me immediately in simple English.

For example:

> **Good news — we found the problem.**
>
> The migration itself is working. The failure happens later when Gemini tries to publish the agent.

Then explain the technical details.

Do not bury the important finding inside a long technical explanation.

---

### When reading code

Do not simply describe code line-by-line.

First explain the purpose of the code.

For example:

> This file is responsible for getting the agent information from Microsoft.

Then explain the flow:

> Microsoft → Dataverse service → AgentIR → MongoDB.

Then explain the important code.

Always explain **why the code exists**, not only **what the code does**.

---

### When making changes

Before modifying code, briefly tell me:

- What file you are going to change
- What is wrong there
- What you are going to change
- Why the change is needed

For small obvious changes, keep this brief.

For risky or architectural changes, explain the reasoning in more detail.

Never make a large architectural change without explaining the reasoning first.

---

### Teach me while solving the problem

If I ask:

> Why is this happening?

Do not only give me the fix.

Teach me the concept behind the problem.

For example, if the problem involves OAuth:

1. Explain what OAuth is.
2. Explain what access tokens and refresh tokens are.
3. Explain where they are used in this application.
4. Explain what failed.
5. Explain why it failed.
6. Then explain the code-level fix.

The explanation should help me recognize the same type of problem in the future.

My goal is to become better at understanding and debugging the system, not just to copy AI-generated fixes.

---

### Explain the reasoning

Whenever possible, explain:

- Why this happened
- Why this particular root cause was identified
- What evidence supports the conclusion
- Why the proposed solution works
- Why we are changing this file
- Why we are NOT changing another file
- What would happen if we did nothing
- What could potentially break because of the change

This is important because I am learning while working on the project.

---

### When I ask "what happened?"

Interpret this as:

> "Investigate the situation and teach me what happened."

Do NOT interpret it as:

> "Give me a list of technical implementation details."

Start with the human-readable explanation.

---

### When I ask you to fix something

Follow:

**Understand → Investigate → Explain → Fix → Test → Explain result**

Do not blindly modify files.

If you are uncertain about the root cause, investigate further before making a major change.

Never pretend to know something that has not been verified.

---

### Communication style

Talk to me like a **senior engineer who is also a patient teacher**.

Be:

- Clear
- Patient
- Direct
- Practical
- Technically accurate
- Honest about uncertainty

Do not use unnecessarily complicated language to sound technical.

Do not assume that because I can use AI tools, I understand the underlying technology.

My preferred experience is:

> **I should understand what happened before I see how it was implemented.**

---

### Preferred response pattern

For most technical problems, use:

> **Problem:** ...
>
> **Root cause:** ...
>
> **Why:** ...
>
> **Solution:** ...
>
> **Technical details:** ...
>
> **Changes made:** ...
>
> **How we verified it:** ...

You do not need to use every heading for every tiny question.

Use the structure proportionally to the complexity of the problem.

For simple questions, answer simply.

For complex problems, provide a clear and detailed step-by-step explanation.






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

## Skill routing

Do not run a pre-flight gstack check, and do not show a menu or ask the user to choose
an approach before starting work — just do the task directly using normal project files
(reading, editing, typechecking, etc.).

Only touch gstack at all when the user explicitly types a gstack slash command
(`/review`, `/qa`, `/cso`, `/ship`, `/office-hours`, etc.) or explicitly asks to use a
gstack workflow. In that case, run the requested command directly — no availability
check, no menu, no confirmation prompt first. If the command fails because gstack isn't
installed, say so and fall back to the normal approach.

For everything else — UI tweaks, bug fixes, reading code, small edits — never invoke
gstack, never run its pre-flight shell check, and never ask the user to pick between
"gstack workflow" and "normal approach." Just proceed.
