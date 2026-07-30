# Memory: Domain Knowledge

Concepts and glossary for CloudFuze Studio Migrate. This is what a new engineer (or Claude)
needs to read the code without reverse-engineering the two platforms.

## The migration in one line

A **Copilot Studio agent** (stored in **Dataverse** as `botcomponent` rows) is extracted into a
neutral **`AgentIR`**, mapped into a **Gemini Enterprise agent** (a Discovery Engine
`lowCodeAgentDefinition`), created/published/shared, verified, and reported on.

## Microsoft / Copilot Studio side

- **Dataverse** — the Power Platform data store holding Copilot agents. Accessed via the
  environment's Web API with **app-only** (`client_credentials`) tokens.
- **`botcomponent.ComponentType`** values we care about (see `types.ts`):
  - `9` Topic — a conversation topic (AdaptiveDialog YAML in `botcomponent.data`).
  - `10` Dialog.
  - `14` BotFileAttachment — an **uploaded knowledge file**; bytes live in the `filedata` File column.
  - `15` CustomGpt — `GptComponentMetadata`, holds the **real agent instructions**.
  - `16` KnowledgeSource — websites, SharePoint, Dataverse QnA, etc.
- **AI Builder** — some (esp. prebuilt/Dynamics) agents put their real "brain" in an AI Builder
  model (`msdyn_aiconfigurations`); the topic's `aiPrompt` is that model's prompt text. Without
  it a migrated agent is an empty shell — so extraction resolves it.
- **Managed/prebuilt agents** (`ismanaged`) may have little authored, extractable text — flagged
  `isManaged` / `thinContent` for an honest fidelity note.
- **`AADSTS*`** — Azure auth errors. `AADSTS65001` = missing delegated consent (why we use
  app-only for Dataverse, not delegated Dynamics); `AADSTS70011` = bad scope combo.

## Google / Gemini Enterprise side

- **Gemini Enterprise / Agentspace** — the destination. Agents are created under a
  **Discovery Engine** `v1alpha` resource: `project` → `engine` (app) → `assistant`.
  This trio is the `GeminiDestination`. The engine is always **discovered**, never hardcoded.
- **`lowCodeAgentDefinition`** — the Gemini agent shape the mapper targets (display name,
  instruction, starter prompts, model, tools).
- **`agentFiles`** — knowledge files attached to a Gemini agent (sub-resource): `files:upload`
  then attach via `UpdateAgent`. Idempotent by filename.
- **Quotas** — Discovery Engine **write** quota is the bottleneck; writes return `429`/`503` and
  must back off (jittered). Phase 2 uses lower concurrency for this reason.
- **Service account access** — Direct IAM (SA granted a Discovery Engine role on the customer
  project) or Domain-Wide Delegation (SA impersonates the customer admin).

## Gemini edition / visibility finding (important, documented)

Migrated agents list in the Gemini **Business** edition UI but **NOT** in Standard/Plus, which
present a *governed gallery* rather than the full agent list. This is expected platform behavior,
not a migration bug. Sources: `docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`,
`docs/GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`, `docs/LIMITATIONS-EDITING-AGENTS.md`, and the filed
`docs/SUPPORT-TICKET-*.md` (quota, visibility, editing deployed agents).

## Project glossary

- **AgentIR** — platform-neutral intermediate representation; the extraction↔mapping contract.
- **FidelityNote** — `{ component, status: mapped|partial|lost|needs-review, detail }`; the
  honesty mechanism in the report.
- **Scope** — what a run migrates: `agents | environments | tenant | selection`. Resolved into a
  flat work-list by `scope.ts`.
- **ResolvedPlan** — a scope resolved to concrete units + destination options, executed by the
  orchestrator.
- **OrganizationProfile** — facts discovered about the customer org (domains, environments,
  project) built once and read by later stages.
- **DWD** — Domain-Wide Delegation (Google). **SA** — service account.