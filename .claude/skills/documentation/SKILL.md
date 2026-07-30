---
name: documentation
description: How CloudFuze Studio Migrate documents itself — the docs/ knowledge base (specs, feasibility, Gemini edition/visibility findings, support tickets), the "why" comment style, and keeping .claude/memory in sync. Use when writing or updating CS_GE docs.
---

# Skill: CS_GE Documentation

Teaches where documentation lives in this repo and the house style, so docs land in the right
place and match the codebase's voice.

## Where docs go

- **`docs/`** — durable engineering knowledge and findings:
  - `AGENTIR_V2_SPEC.md` — the IR specification (the contract). Update when `AgentIR` changes.
  - `architecture/topics-migration-production.md` — the production topics-migration design.
  - `MIGRATION-V1.md`, `knowledge-sources-migration-playbook.md` — stage playbooks.
  - `GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`, `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`,
    `LIMITATIONS-EDITING-AGENTS.md` — hard-won findings about Gemini's real behavior/limits.
  - `SUPPORT-TICKET-*.md` — filed tickets (quota, visibility, editing deployed agents).
  - `ONBOARDING_AND_LICENSING.md` — customer onboarding / licensing.
- **`.claude/memory/`** — Claude-facing project knowledge (context, architecture, decisions,
  domain, progress, repo map). Keep in sync when the corresponding `docs/` fact changes.
- **`README.md`** — the short public overview (stage table, layout, quick start). Keep lean.
- **Code comments** — explain the **why** inline (see below).

## House style

- **Honesty first.** This project's docs are candid about limits (what Gemini *won't* do, what a
  migration *loses*). Never document an aspiration as a fact. If a claim is unverified, say so —
  the fact-check and limitations docs exist precisely for this.
- **Findings are evidence-backed.** When you document Gemini/Dataverse behavior, cite the probe
  or ticket (`_diag_*` run, support ticket) that established it.
- **"Why" comments in code.** Match the existing density — comments explain *why* a decision
  was made (quota backoff, idempotency, ASCII log mirroring), not what a line does. Don't strip
  them.
- **Markdown tables** for stage/mapping/edition matrices (the codebase favors them).

## When you change behavior

1. Update the relevant `docs/` file (spec/playbook/finding).
2. Mirror the fact into the matching `.claude/memory/*.md` if it's stable knowledge.
3. If it's an architectural decision, add a dated entry to
   [.claude/memory/decisions.md](../../memory/decisions.md).
4. Use gstack **`/document-generate`** / **`/document-release`** for release notes and generated
   docs — this skill governs the repo's own hand-written knowledge base.