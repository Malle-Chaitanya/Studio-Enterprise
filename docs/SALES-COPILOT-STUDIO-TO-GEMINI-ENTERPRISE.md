# CloudFuze Studio Migrate — Sales Brief

## Microsoft Copilot Studio to Google Gemini Enterprise

**Audience:** Sales, Solution Consultants, Partner Managers
**Date:** 2026-08-20
**Rule of the house:** honest by design. Overclaiming a migration is a trust failure, not a demo win. Everything in this brief is backed by a live test against a real tenant or by an official vendor document. Where we have not proven something, it says so.

---

## 1. The pitch in one paragraph

A customer who has built AI agents in **Microsoft Copilot Studio** and is moving to **Google Gemini Enterprise** faces a rebuild: every agent's instructions, conversation logic, knowledge and tool wiring lives inside Microsoft's platform, in Microsoft's format. CloudFuze Studio Migrate reads each agent out of Copilot Studio losslessly, translates it into a native Gemini Enterprise agent inside the customer's own Google project, deploys it, asks it a real question to prove it works, and hands back a per-agent report of exactly what carried over and what needs a human. The customer keeps the work they invested in their agents instead of rebuilding them by hand.

**The 30-second version for a call:**

> "We migrate your Copilot Studio agents into your own Gemini Enterprise with high fidelity — the agent's instructions, its conversation logic, its starter prompts, and its uploaded knowledge files — and we show you a per-agent report of exactly what carried over. To make each agent live to your whole organization, an admin clicks Publish once per agent in Gemini, because Google does not expose an API for that step yet. We also read who owned and could access each agent, and hand your admin a pre-mapped checklist to reproduce that access."

Do not go beyond that claim without checking section 6 and section 11.

---

## 2. The two platforms

### Microsoft Copilot Studio (the source)

Copilot Studio is Microsoft's low-code platform for building conversational AI agents inside Microsoft 365 and the Power Platform. A customer's agents live in **Dataverse**, the Power Platform database, and an agent is assembled from several parts:

| Part of a Copilot agent | What it is |
|---|---|
| **Instructions** | The agent's system prompt — its persona, rules and tone. The real "brain." |
| **Topics** | Authored conversation flows: trigger phrases, branching questions, actions. Stored as dialog definitions. |
| **Knowledge sources** | Uploaded files, SharePoint sites, public websites, Dataverse tables the agent can answer from. |
| **Connectors and actions** | Live API calls the agent can make at question time — Outlook, SharePoint, Teams, Jira, HubSpot, Dataverse, custom connectors, Power Automate flows. |
| **AI Builder prompts** | For some prebuilt and Dynamics agents, the real instruction text lives in a separate AI Builder model rather than in the agent record. |
| **Ownership and sharing** | Who owns the agent, who it was shared with, who is allowed to chat with it. |
| **Publish state** | Whether the agent was live to users or still a draft. |

That structure matters commercially: a competitor that only copies the agent's name and description delivers an empty shell. The instructions, the topics and the AI Builder prompt are where the customer's actual investment sits.

### Google Gemini Enterprise (the destination)

Gemini Enterprise (also referred to as Agentspace) is Google's enterprise AI agent platform. Agents live under Google's **Discovery Engine** service in the customer's own Google Cloud project, arranged as project → app (engine) → agent. A Gemini agent is assembled from:

| Part of a Gemini agent | What it is |
|---|---|
| **Display name and instruction** | The agent's identity and system prompt. |
| **Starter prompts** | Suggested questions shown to a user opening the agent. |
| **Agent files** | Knowledge documents attached directly to the agent. |
| **Tools** | Code the agent can execute to make live API calls — deployed as a Python agent on Google's Reasoning Engine. |
| **Sharing config** | Today, effectively org-wide access or not. |
| **State** | `PRIVATE` (visible only to its creator) or `ENABLED` (live to users who have access). |

### How the concepts line up

| Copilot Studio | Gemini Enterprise | Fidelity |
|---|---|---|
| Agent instructions | Agent instruction | Carried verbatim |
| Topics (dialog flows) | Compiled "conversation procedures" inside the instruction | Behavior preserved, form changes |
| Starter / suggested prompts | Starter prompts | Direct |
| Uploaded knowledge files | Agent files | Direct, idempotent by filename |
| SharePoint / website / Dataverse knowledge | Data store indexing | Reported, not yet wired — see section 6 |
| Connector actions | ADK Python tools calling the vendor API | Rebuilt per connector — see section 7 |
| Owner and shared users | Sharing config plus a mapped checklist | Org-wide automatic, granular manual |
| Published / draft state | `ENABLED` / `PRIVATE` | Read honestly, publish is a manual click |

The two platforms are not shaped the same. Copilot expresses conversation logic as a visual flow graph; Gemini expresses it as instruction text executed by a model. Our translation compiles the one into the other so the migrated agent *behaves* the same, and the report says where that translation lost precision.

---

## 3. Why a customer is having this conversation

- They are consolidating onto Google Workspace and Gemini and do not want two AI platforms.
- Their Copilot Studio agents represent months of authored work they do not want to rebuild.
- They need to know, before committing, what will and will not survive the move. Most vendors cannot tell them.
- Their licensing has shifted and Copilot seats are being retired on a date.

The buyer is usually a platform or AI lead, with a Microsoft admin and a Google admin as the two people who must act.

---

## 4. What the engagement looks like

Five phases. Nothing is written to Google until the customer approves the assessment.

**Phase 1 — Connect and discover.** The Microsoft admin connects the tenant; the Google admin identifies the destination project. We read every Copilot agent out of Dataverse — instructions, topics, knowledge, connectors, ownership — into a neutral internal representation. Read-only. Nothing written to Google.

**Phase 2 — Assessment.** A per-agent report: what migrates cleanly, what migrates with limits, what does not migrate, and why. **This is where surprises are supposed to happen.** It is also the strongest thing we bring to a deal — the customer can size the project honestly before spending money.

**Phase 3 — One-time Google grant.** The Workspace admin authorizes CloudFuze's service account on the customer's project, or the admin signs in via OAuth. Roughly two minutes of admin work. Anything touching Gmail or Drive requires an exact-scope domain-wide delegation entry; nothing works until it exists.

**Phase 4 — Migration.** Agents are created in the customer's own Gemini Enterprise, knowledge is attached, tools are rebuilt against Google or vendor APIs, and each agent is deployed.

**Phase 5 — Verification.** Every migrated agent is asked a real question and its answer inspected, including whether its tools actually fired. **An agent that deploys but cannot answer is reported as failed, not as migrated.** That single rule is our credibility.

Two engineering properties worth mentioning to a technical buyer: the extract and insert stages are separated by a staging database, so a failed migration run replays without re-reading the source tenant, and every write path is idempotent — re-running never produces duplicate agents or duplicate files.

---

## 5. What we can promise

Sell these with confidence.

- **High-fidelity extraction** from Copilot Studio: real instructions verbatim, custom topics compiled into followable conversation procedures, starter prompts, and uploaded knowledge files attached to the migrated agent.
- **The customer's own Gemini Enterprise** is the destination — their project, their app, discovered live at runtime. Nothing is hardcoded, so it works against any customer project unchanged. We never host the customer's agents in a CloudFuze project.
- **Automatic org-wide sharing** applied by API.
- **A per-agent fidelity report** stating what mapped fully, what needs review, and what was lost.
- **Source ownership and access captured and reported** before anything is written, so the customer sees who had access to what.
- **Works on all Gemini editions** for the migration itself.
- **Idempotent and resumable** — re-running is safe; a failed run is retryable without re-extracting.
- **Honest verification** — each agent is challenged with a real question post-migration.
- **Multi-tenant and isolated** — every customer's data is scoped to that customer.

---

## 6. What needs a manual step, and what we cannot do

### Needs a manual step — set this expectation up front

| Item | Why | What the customer does |
|---|---|---|
| **Publishing an agent so the org can see it** | Migrated agents land in `PRIVATE` state. Google removed the API that flipped an agent live (Feb 2026); `state` is now immutable via API. | An admin clicks Publish once per agent in the Gemini UI. We flag exactly which agents were live in Copilot, so they only publish those. |
| **Granular per-user or per-group access** | Google's API supports org-wide access only. Per-user sharing exists only in the Gemini console. | The admin works through our pre-mapped checklist: which Google users and groups to add, and where. |
| **Google domain-wide delegation grant** | Required before any Gmail or Drive tool works. Scope strings must match exactly. | One admin entry, about two minutes. |

### Cannot do today — do not promise these

- **Auto-publish agents via API.** Blocked by Google's removal of the enable API.
- **Per-user or per-group permissions via API.** Org-wide only.
- **Assign or transfer agent ownership** to a named person. Ownership follows whoever created it.
- **Preserve permission *levels*** (view versus edit versus manage). Gemini agents have no multi-level access list.
- **Rebuild every connector action automatically.** See section 7 for what is proven and what is not.
- **Migrate non-file knowledge** (websites, SharePoint sites, Dataverse tables) into Gemini knowledge. Reported honestly, not silently dropped.
- **Migrate flows and workflows.** Current scope is agents only; flows are a later phase.
- **Migrate mail, files or any content.** This tool moves agents. It does not copy a single message or document. Mailbox and content migration are separate CloudFuze projects.

### By Gemini edition — what the customer will actually experience

| | **Business** | **Standard / Plus** |
|---|---|---|
| Migration runs | Yes | Yes |
| Visible to the admin who ran it | Immediately, as a `PRIVATE` draft | Exists; reachable by direct link |
| Visible to other users in the org | After one manual Publish per agent | Blocked — the governed gallery lists only enabled agents, and there is no self-serve enable |
| Org-wide sharing applied | Yes, but inert until published | Yes, but the agent will not list until enabled |
| Granular per-user share | Manual, in the Agent Designer share dialog | Manual, in Cloud Console user permissions |
| Honest positioning | "Strong fit — one publish click per agent and your team sees them." | "Migration and reporting work today; org-wide UI listing depends on Google's enable step. Set this expectation." |

**Business is the smoother story and the better demo.** For Standard and Plus enterprise deals, raise the gallery listing gap yourself, early. It is a Google platform gap, not a defect in our product, and a customer who hears it from us first trusts the rest of the report.

---

## 7. Connectors and tools — the part to be careful with

A Copilot agent that calls Outlook or Jira at question time has a **tool connector**. Migrating it means rebuilding that API call as code the Gemini agent can execute. This is the most technically variable part of the product, so it needs precise language.

Two different things are both called "connector," and conflating them causes confusion:

- **Knowledge connector** — indexes content so the agent can search it. Failure looks like missing documents.
- **Tool connector** — makes a live API call at question time. Failure looks like a tool error mid-answer.

SharePoint is both at once: its content can migrate as knowledge while its table operations migrate as a tool.

### What is proven live

| Surface | Status |
|---|---|
| Gmail mail operations | 15 of 15 exercised against a real mailbox (2026-08-19) |
| Outlook mail on Microsoft Graph | 14 of 14 exercised against a real mailbox (2026-08-19) |
| Jira | Proven live — 92 projects, 20 issues returned |
| Confluence | Proven live |
| HubSpot CRM | Proven live — 5 companies returned (2026-08-16) |

Mail capabilities working today, each tested against a live mailbox: search, read a message, list labels, read text attachments, create / edit / list / send drafts, send, reply with correct threading, forward, move to trash, add and remove labels, star, mark read or unread.

Note the important distinction the customer will care about: **a migrated agent's mail tool calls whichever API the mail actually lives behind.** If the mail stays in Microsoft 365, the tool calls Microsoft Graph. If the mail moves to Google, it calls Gmail. Either way, no message is copied by this tool.

### What is bound but not yet proven

Thirteen connectors are registered in the binding registry with captured API definitions for twelve. Of the Microsoft surface: Dataverse (93 operations), Power Platform Admin (189), Teams (170) and Dynamics CRM bind mechanically. Office 365 Outlook (143), SharePoint Online (141) and OneDrive (56) are explicitly refused rather than guessed, because their Power Platform definitions describe a dataset abstraction rather than the real vendor API — a wrong host produces a tool that fails confusingly at runtime, which is worse than a clear refusal. Purpose-built SharePoint file tools ship instead.

Measured position: **452 operations bindable, 340 blocked.**

**Language discipline:** "bindable" is not "works." A connector can bind, deploy and register cleanly and still never have made a single successful call. Say **proven** only for the rows in the proven table above. For anything else, say "bound, and we will prove it against your tenant during assessment."

### A number worth correcting in front of a customer

The Outlook connector advertises 143 operations. Subtract 89 deprecated versions of the same calls and 34 event triggers, and the real pickable surface is **49 operations**. Anyone sizing this work off 143 is sizing roughly three times the reality and will quote a timeline to match. Being the vendor who corrects that number is a credibility win.

---

## 8. What the customer has to provide

| Item | Who | Effort |
|---|---|---|
| Microsoft tenant admin consent for agent extraction | Microsoft admin | Minutes |
| An existing Gemini Enterprise subscription with seats | Customer, already in place | Prerequisite |
| Access for CloudFuze's service account on their Google project, or admin OAuth sign-in | Google admin | Minutes |
| Domain-wide delegation entry with exact scopes, if Gmail or Drive tools are in scope | Workspace admin | About two minutes |
| Review and approval of the assessment report before migration | Project owner | Real reading time — encourage it |

### Two licensing facts that cause avoidable escalations

- **Gemini Enterprise seats are scoped to the organization; agent-creation quota is scoped to the individual project.** A subscription covers every project in the same org, but each project has its own allotment of agent slots.
- The error "agent creation quota exceeded" does **not** mean the customer has no subscription. It means that project's agent slots are full. Fix by deleting unused agents or raising the tier. Being an Owner on a project is not the same as holding a seat; both are needed.

---

## 9. Why us

- **We read the real agent, not the label.** Instructions verbatim, topics compiled, AI Builder prompts resolved. An agent migrated as a name and a description is an empty shell, and customers find that out in week six.
- **The report is the product.** A per-agent, honest account of mapped, partial, lost and needs-review. It is what lets a customer plan, and it is the hardest thing for a competitor to fake.
- **We verify with a real question.** Deployed is not migrated. An agent that cannot answer is reported as failed.
- **The customer's cloud, not ours.** Their project, their app, discovered at runtime. No lock-in to a CloudFuze-hosted environment.
- **Safe to re-run.** Idempotent and resumable, with the extract and insert stages decoupled by staging.
- **We tell you the limits first.** Every gap in section 6 is one we raise, not one the customer discovers.
- **CloudFuze already does the rest of the move.** Mail, files and content migration are existing CloudFuze products. Agents are the piece nobody else covers.

---

## 10. Objection handling

**"Will my agents work exactly the same?"**
The instructions and conversation logic carry over and the agent behaves the same for the paths it was authored for. Where a topic called an external connector action, we describe it and either rebuild the tool or flag it for rebuild — the report tells you which, per agent, before you commit.

**"Will everyone in my org see the migrated agents automatically?"**
An admin clicks Publish once per agent. Google removed the API for that step in February 2026. We tell you exactly which agents were live in Copilot so you only publish those.

**"Can you replicate our exact permissions?"**
We read the source access list, map those users to their Google identities, apply org-wide access by API, and hand your admin a pre-mapped checklist for anything narrower. Google's API does not currently support per-user agent sharing.

**"Does this move our mail and files?"**
No. This tool moves agents. Not one message or document is copied by it. CloudFuze has separate products for mail and content migration.

**"What about our Power Automate flows?"**
Current scope is agents. Flows are a later phase. Flow-backed actions inside topics are described and flagged for rebuild rather than silently dropped.

**"How do I know it worked?"**
Every migrated agent is asked a real question and its answer inspected, tool calls included. You get a per-agent pass or fail, not a green checkmark for a successful upload.

---

## 11. Rules for the team

- **Never** say agents automatically go live to everyone. Say "one publish click per agent."
- **Never** say we replicate exact per-user permissions. Say "we map access and give a pre-mapped checklist."
- **Never** promise Standard or Plus gallery listing without naming Google's enable gap.
- **Never** say a connector "works" unless it appears in the proven table in section 7. Otherwise say "bound, and we prove it during assessment."
- **Never** imply mail or file content moves with the agents.
- **Always** lead with the strong, true part: high-fidelity agent, topics, knowledge, honest report, verified answer.
- **Always** route a specific fidelity question back to the assessment. It exists so nobody has to guess on a call.

---

## 12. Glossary

| Term | Plain meaning |
|---|---|
| **Copilot Studio** | Microsoft's low-code platform for building AI agents. |
| **Dataverse** | The Power Platform database where Copilot agents are stored. |
| **Gemini Enterprise / Agentspace** | Google's enterprise AI agent platform, the destination. |
| **Discovery Engine** | The Google service that holds Gemini agents and knowledge. |
| **Agent files** | Knowledge documents attached directly to a Gemini agent. |
| **`PRIVATE` / `ENABLED`** | A Gemini agent's state: visible only to its creator, versus live to users. |
| **Fidelity report** | Our per-agent account of what mapped, what is partial, what was lost, what needs review. |
| **Service account** | The CloudFuze identity a customer grants access to their Google project. |
| **Domain-wide delegation** | The Workspace admin grant that lets that identity act for the customer's users. |
| **Idempotent** | Re-running produces no duplicates. |
| **Tool connector** | Agent capability that makes a live API call at question time. |
| **Knowledge connector** | Agent capability that indexes content for search. |

---

## Where the facts come from

Live API probe of a real Gemini Business tenant; the official Discovery Engine v1alpha API schema and its 2026-02-10 changelog recording the removal of `enableAgent`, `disableAgent` and `suspendAgent`; official Microsoft Dataverse documentation for agent status and record sharing; live connector runs recorded in the project verification ledger (Gmail and Outlook mail surfaces, 2026-08-19; Jira, Confluence and HubSpot, 2026-08-16); and counted operation totals from captured connector API definitions.

Deeper internal detail: `docs/AGENT-MIGRATION-CAPABILITIES.md`, `docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`, `docs/CONNECTORS-STATE-OF-KNOWLEDGE.md`, `docs/M365-TO-WORKSPACE-JOURNEY.md`, `docs/MS-CONNECTOR-PARITY-SPEC.md`, `docs/ONBOARDING_AND_LICENSING.md`, `docs/verification-ledger.md`.
