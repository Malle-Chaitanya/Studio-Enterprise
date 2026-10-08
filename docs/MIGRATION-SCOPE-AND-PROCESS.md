# CloudFuze Studio Migrate — Source, Destination, Scope & Process

## Source and destination

| | **Source: Microsoft Copilot Studio** | **Destination: Google Gemini Enterprise** |
|---|---|---|
| What it is | Microsoft's low-code platform for building AI agents inside Microsoft 365 / Power Platform | Google's enterprise AI agent platform (also called Agentspace) |
| Where agents live | **Dataverse** — the Power Platform database | **Discovery Engine**, inside the customer's own Google Cloud project |
| What an agent is built from | Instructions (system prompt), topics (conversation flows), knowledge sources (files, SharePoint, websites, data tables), connectors/actions (live API calls), AI Builder prompts, ownership & sharing, publish state | Display name & instruction, starter prompts, agent files (attached knowledge), tools (live API calls via a deployed Python agent), sharing config, state (`PRIVATE` draft or `ENABLED` live) |
| Whose project | The customer's Microsoft tenant | The customer's own Google Cloud project — never a CloudFuze-hosted environment |

The two platforms don't express things identically — Copilot represents conversation
logic as a visual flow graph; Gemini represents it as instruction text executed by a
model. Migration translates one into the other so the agent *behaves* the same, and
reports honestly where that translation loses precision.

## In scope today

**Phase 1 = agents, migrated with the goal of high fidelity** — behaving like the
original, not just resembling it on paper:

- **Instructions** — carried over verbatim from the real source, never guessed or
  reconstructed.
- **Topics / conversation flows** — compiled into the destination's equivalent while
  preserving behavior.
- **Knowledge sources** — uploaded files, SharePoint, Confluence, structured data
  tables — rebuilt the closest equivalent way on the Google side.
- **Tools / integrations** — read from a dynamic connector registry that captures each
  connector's real, live definition directly from Microsoft's own API rather than a
  hardcoded list: 281 connectors captured so far, 150 already producing a real working
  migrated tool, and more coming online as they're verified.
- **Agent Flows** — a Power Automate flow that one of the agent's own actions calls is
  translated into a Google Cloud Application Integration and wired into the deployed
  agent as a genuine callable tool (not just described in the report).
- **Ownership and sharing** — who owns the agent and who it's shared with, read and
  reported; org-wide access applied automatically on the destination side.
- **Publish state** — whether the source agent was live or still a draft.

Works the same whether the customer migrates one agent, one department, or an entire
tenant — the scope changes, the process underneath doesn't.

## Out of scope (for now)

Being explicit about limits is a product principle here, not an afterthought:

- **Stand-alone workflow migration.** A flow not tied to any agent, or a general
  "migrate our workflows" feature, is a proposed later phase — design written, not yet
  built.
- **Fine-grained document access.** If a folder was restricted to one team in the
  source, that restriction isn't automatically recreated on the destination side — it's
  flagged for a human to apply, not silently dropped or silently over-shared.
- **Per-user tool authorization.** A tool that ran "as whoever was chatting" in Copilot
  runs as one shared service account after migration instead — broader access, not
  narrower. Detected and reported today; not yet auto-fixed.
- **Evaluation/test question sets, disabled components, Adaptive Card UI** — read and
  named in the report, but not migrated.
- **Some Microsoft prebuilt agents** whose real logic isn't stored anywhere readable —
  these come across as an empty shell and need a person to author them.
- **Granular sharing on the destination side.** Google's API only supports org-wide
  sharing automatically; narrower sharing is a manual checklist, not an API call.
- **Mail, files, or any document content.** This tool moves agents only — not a single
  message or file is copied by it (CloudFuze has separate products for that).
- **Auto-publishing an agent to the whole org.** Blocked by a Google platform limit, not
  ours — an admin still clicks Publish once per agent.

## The migration process

Five phases, read-only until the customer explicitly approves moving forward:

1. **Connect & discover.** The Microsoft admin connects their tenant; the Google admin
   identifies the destination project. Every agent is read out of Dataverse — read-only,
   nothing written to Google yet.
2. **Assessment.** A per-agent report: what migrates cleanly, what migrates with
   limits, what doesn't migrate, and why. This is where the customer sizes the project
   honestly before spending money — surprises are meant to surface here, not later.
3. **One-time Google grant.** The Google admin authorizes CloudFuze's service account
   on the customer's own project (or signs in via OAuth) — a few minutes of admin work.
4. **Migration.** Agents are created in the customer's own Gemini Enterprise, knowledge
   is attached, tools and flows are rebuilt, and each agent is deployed.
5. **Verification.** Every migrated agent is asked a real question and its answer is
   inspected, tool calls included. An agent that deploys but can't actually answer is
   reported as **failed**, not as migrated.

The end result is a per-agent fidelity report: what mapped fully, what needs review,
and what was lost — never a rosier picture than what actually happened.
