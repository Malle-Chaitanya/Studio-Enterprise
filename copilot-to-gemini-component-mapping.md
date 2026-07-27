# Copilot Studio → Gemini Enterprise — Component Inventory & Intelligence Mapping

> Reference for the migration tool. Source = **Microsoft Copilot Studio**, Destination = **Google Gemini Enterprise**.
> State-of-product: mid-2026. Verify version-sensitive items (model names, API surfaces) at build time.

---

## 0. The one thing that shapes the whole engine

The two platforms do **not** share an architecture. This is the single most important design fact for your mapper:

| | Copilot Studio (source) | Gemini Enterprise (destination) |
|---|---|---|
| **Core paradigm** | **Declarative dialog graph** — topics made of typed nodes (message, question, condition, loop, action) with explicit trigger phrases and slot-filling | **Instruction-driven agents** — behavior is natural-language *Instructions*; multi-step logic is either instruction+context (no-code) or **code** (ADK Sequential/Parallel/Loop agents) |
| **Determinism** | Author-controlled, node-by-node deterministic flow | LLM-orchestrated by default; determinism only via ADK workflow-agent code |
| **Automation** | **Agent flows** / **Workflows** (Power Automate engine, deterministic) | ADK workflow agents / Application Integration / Cloud Functions (code) |
| **Serialization** | Dataverse solution `.zip` → `bot` + `botcomponent` records; topics as **YAML (AdaptiveDialog)**; flows as **Workflow Definition Language JSON** | No import/JSON schema for no-code agents. Programmatic path = **ADK code** + **Discovery Engine REST register API** |

**Consequence:** there is no 1:1 structural translation. A Copilot topic (a branching node tree) has **no native equivalent** in Gemini's no-code agent — it must be *flattened* into Instructions + Tools, or *re-expressed as code* in an ADK agent. That flattening is where "intelligence" (LLM-assisted transformation) is mandatory, not optional.

---

## 1. Source inventory — Copilot Studio components

> Detect **classic** vs **new** experience first — they serialize completely differently and Microsoft provides **no migration path between them**. The classic solution `.zip` is your richest parse surface.

### 1.1 Agent (top-level `bot`)
- `Name` (≤42 chars, no `< >`), `Description` (≤1024), `Instructions` (≤8000, rich text, supports `/`-references to tools/topics/vars + Power Fx), `Icon`, primary/secondary languages.
- Orchestration toggle (classic): generative vs classic. New experience = always enhanced runtime.
- Owns: Topics, Tools, Knowledge, Child agents, Entities, Variables, Auth, Channels.

### 1.2 Topics
- Fields: Name (no `.` — breaks export), Display name, Description, input/output params, one Trigger, node graph.
- **Trigger types:** phrase-based (`OnRecognizedIntent`, 5–10 phrases), description-based ("agent chooses"), system/lifecycle (`Conversation Start`, `On Error`, `On Unknown Intent`, `Inactivity`, `On Sign In`, `AI response generated`, `Plan complete`), and **event triggers** (Dataverse row change, SharePoint item, OneDrive file, Planner task, Recurrence — emit JSON/text payload; generative only).
- **Node types:** Message, Question (entity + save-as-var + retry + skip logic), Adaptive Card, Condition (`ConditionGroup`, Power Fx), Variable management (set/parse/clear), Topic management (redirect/transfer/end), Tool/Action call, Advanced (Generative answers, HTTP request, Send event, Auth).
- Serializes to **YAML `kind: AdaptiveDialog`**, every node has an `id`.

### 1.3 Entities & slot filling
- Prebuilt (~30: Date, Email, Number, Person, City, Money, URL…), Custom **closed list** (items + synonyms + smart matching), Custom **regex** (.NET / JS), **dynamic/open list** (from table var).
- Slot filling: proactive multi-slot fill, multiple values → table, "one of multiple entities" (≤5).
- ⚠️ In **generative orchestration, custom entities are NOT supported as tool/topic inputs**.

### 1.4 Variables
- Scopes: Topic, Global, System, Environment (read-only). Types: String, Bool, Number, Table, Record, DateTime, Choice, Blank.
- Rich `System.*` set (Activity.*, Conversation.*, User.*, Recognizer.*, Error.*).

### 1.5 Agent flows (deterministic automation)
- Structure: 1 trigger + ≥1 action. Triggers: instant/manual, scheduled (Recurrence), event, **"When an agent calls the flow"** (required to be a tool).
- Actions: AI capabilities, Human-in-the-loop (approvals), built-in control (Condition, Switch, Apply to each, Do until, Scope), connectors (M365 / 3rd-party / custom).
- Error handling: "Configure run after". Expressions: Workflow Definition Language.
- As a tool: needs "Respond to the agent", async off, published, ≤100s.

### 1.6 Workflows (new agentic canvas)
- Same trigger/action model as agent flows + **native AI actions**, **Agent node** (hand a step to an AI agent — existing or inline), **node-level testing**.
- Cannot convert to/from classic agent-flow format.

### 1.7 Tools / actions / plugins
- Connector (prebuilt/custom), agent flow/workflow, **Prompt** (single-turn model call), **REST API** (OpenAPI v2), **MCP** (wizard creates a custom connector to server `/mcp`; exposes Tools + Resources; requires generative orchestration), Computer use, Skills, Client tools.
- Per tool: Details (name/description/dynamic-use/ask-before-run/auth), Inputs (dynamic-fill-with-AI vs custom value), Completion (don't respond / generative / specific / adaptive card).
- Limit: 128 tools/agent (rec. 25–30).

### 1.8 Knowledge sources
- Public website (Bing-scoped), uploaded documents, SharePoint, Dataverse, enterprise connectors (Microsoft Search-indexed), + classic-only Azure OpenAI / Bing Custom Search / custom.
- Settings: allow ungrounded, web search, content moderation level, semantic/tenant-graph grounding.

### 1.9 Auth & security
- No auth / Authenticate with Microsoft (Entra) / Manual (Entra v1/v2, Generic OAuth2 — full token/authorize/refresh URL template fields).
- Connections = Power Platform **connection references**. DLP policies gate event triggers & manual auth.

### 1.10 Channels
- Teams + M365 Copilot, SharePoint, WhatsApp, custom website, mobile (Direct Line), Facebook, Azure Bot channels (Slack, Telegram, Twilio SMS, Email…), telephony/voice.

### 1.11 Export
- Power Platform solution `.zip`: `bot` + `botcomponent` (topics as YAML), flows as JSON, env vars + connection refs as separate components; references via Dataverse **GUIDs** + schema names. `pac copilot` CLI.

---

## 2. Destination inventory — Gemini Enterprise components

> Product hierarchy (2026): **Gemini Enterprise** (umbrella) = **Gemini Enterprise app** (end-user: Agent Designer, Agent Gallery) + **Gemini Enterprise Agent Platform** (developer, formerly Vertex AI: Agent Studio, ADK, Agent Runtime, Models, Data stores). Agentspace → Gemini Enterprise (Oct 2025); Vertex AI → Agent Platform (Apr 2026).

### 2.1 Object model
`App` (top-level container) → **Data stores** (content) → **Assistant** → **Agents** (Dialogflow / A2A / **ADK** / A2UI types, registered).

### 2.2 Agent Designer (no-code/low-code)
- Single-step vs **multi-step** (main agent + subagents). Canvas: Chat pane (NL) + Designer pane (Flow / Schedule / Preview tabs). GA Jan 2026; visual flow builder (V2) Nov 2025.

### 2.3 Agent object fields
- **Name, Description, Instructions** (system prompt — folds goal/persona/tasks), **Model**, **Data and tools**, **Knowledge** (file upload), **Personalization → Starter prompts** (≤3 shown), **Subagents**, **Schedule**.
- No separate icon/goal/persona/sample-question fields in no-code UI (folded into Instructions / Starter prompts).

### 2.4 Multi-step orchestration
- **No-code:** main node + "Add subagent"; chaining via Instructions + shared context. No public declarative step schema (no typed inputs/outputs/branching primitives).
- **ADK (code):** the real deterministic step model —
  - `SequentialAgent(name, sub_agents[], description)` — ordered; shares `InvocationContext`; results via `output_key`, referenced as `{var}` in later instructions.
  - `ParallelAgent(name, sub_agents[], description)` — concurrent, isolated branches, merged downstream.
  - `LoopAgent(name, sub_agents[], max_iterations)` — repeat until `max_iterations` or `context.actions.escalate=True`.
  - Dynamic routing: LLM agent with `sub_agents` (delegation); distributed via **A2A protocol**.

### 2.5 Triggers & scheduling
- **Schedule object** (only in-app recurring trigger): frequency (Hourly/Daily/Weekly/Monthly/Annually), execution time, timezone, prompt. Draft→Update to activate. OAuth expires 14 days; ≤5-min delay; multi-region only.
- **Event triggers** = architecture pattern (Pub/Sub → Cloud Function/FastAPI → agent), not a declarative in-app object.

### 2.6 Tools / actions / connectors
- Built-in: Google Search, URL context. Google Workspace tools (Gmail, Drive, Calendar). Third-party (Jira, ServiceNow…).
- **Function calling** via **OpenAPI schema** (declaration compatible with OpenAPI).
- **MCP**: custom MCP server data store; Agent Platform remote MCP server; MCP Toolbox for Databases. (In GE data stores, MCP "tools" are called **actions**.)

### 2.7 Data stores / knowledge / grounding
- **Agent Search** (formerly Vertex AI Search) via **Discovery Engine** data stores. Out-of-box connectors: Google Workspace (Gmail/Drive/Calendar), Microsoft Office, Jira, ServiceNow; **custom connectors** load into Discovery Engine data stores. Grounding with Google Search (public) or data stores (private); Grounding API.
- No-code: **Knowledge → Add files** for direct uploads.

### 2.8 Human-in-the-loop
- Draft→confirm action model (Gmail/Calendar show fields for review before send). Unified **Inbox** for approvals. Scheduled agents auto-pause any action affecting **other people**. ADK/platform risk-threshold gating → durable "pending approval" checkpoint. No single named "approval step" object.

### 2.9 Programmatic creation path (critical for the writer)
- **ADK** (Python/TS/Go/Java) → deploy to **Agent Runtime** / Cloud Run / GKE.
- **Register the agent** to the Gemini Enterprise app via Discovery Engine REST:
  ```
  POST https://{us|eu|global}-discoveryengine.googleapis.com/v1alpha/projects/{PROJECT}/locations/global/collections/default_collection/engines/{APP_ID}/assistants/default_assistant/agents
  body: { displayName, description, icon.uri?,
          adkAgentDefinition.provisionedReasoningEngine.reasoningEngine,
          authorizationConfig.toolAuthorizations[]? }
  ```
- OAuth tool auth: `POST .../authorizations?authorizationId=...` with `clientId, clientSecret, authorizationUri, tokenUri`.
- Agent Studio "Get code" exports visual design to code. Client libs: Python/Go/Java/Node/C#.

### 2.10 Models
- Gemini 3.x family current (3.1 Pro, 3.5/3.6 Flash, 3.5 Flash-Lite…); 2.5 Pro/Flash selectable as prior-gen. Agent Designer default drifted 3.1 Pro → 3.5 Flash → 3.6 Flash across mid-2026.
- Params (API/Agent Studio level, not no-code UI): temperature (0–2), topP, topK, candidateCount, maxOutputTokens, stopSequences, presence/frequencyPenalty, responseMimeType, seed, thinking budget.

### 2.11 Deployment surfaces
- Gemini Enterprise web + mobile app, Google Chat (Apps Script add-on), Chrome omnibox `@gemini`, embedded via A2UI, API/client libs. Agent Gallery: Made by Google / From your org / Your agents / Marketplace. Invoke via `@agent_name`. Admin states: Private/Enabled/Suspended/Disabled.

---

## 3. Component-by-component mapping + intelligence tier

**Intelligence tiers** (how your engine handles each):
- **D — Direct**: field-to-field copy/rename. Deterministic code.
- **T — Transform**: structural reshape, deterministic rules (e.g., YAML node → OpenAPI param).
- **A — AI-assisted**: requires an LLM to reinterpret intent (e.g., dialog tree → instructions). Non-deterministic; needs review.
- **M — Manual/flag**: no automated path; surface to user with guidance.
- **X — Unsupported/drop**: no destination equivalent; log as fidelity loss.

| # | Copilot Studio component | Gemini Enterprise target | Tier | Intelligence / transform needed |
|---|---|---|---|---|
| 1 | Agent name, description, icon | Agent `displayName`, `description`, `icon.uri` | **D** | Truncate to GE limits; convert icon to hosted URI |
| 2 | Agent **Instructions** | Agent **Instructions** | **A** | Rewrite: strip Power Fx / `/`-refs, re-target citation & tool references to GE tool names; preserve intent |
| 3 | Primary/secondary languages | Agent language config | **D/M** | Map locale codes; multi-language handling differs |
| 4 | **Topic (phrase-triggered)** | Fold into Instructions + Starter prompts | **A** | Trigger phrases → NL "when the user asks about…" in Instructions; phrases → Starter prompts |
| 5 | **Topic node graph** (message/question/condition/loop) | Instructions (no-code) **or** ADK Sequential/Loop agent (code) | **A** | Flatten branching tree into ordered NL steps, or generate ADK code with `sub_agents`/`output_key`/`max_iterations`. Core "intelligence" work |
| 6 | Question node + entity/slot | Instruction "ask the user for X" / function param | **A/T** | Slot → tool input param (OpenAPI); reprompt/retry logic largely lost |
| 7 | Condition (`ConditionGroup`, Power Fx) | Instruction conditional **or** ADK code branch | **A** | Translate Power Fx expression → NL condition or Python. Power Fx has no GE equivalent — must be interpreted |
| 8 | Loop / Apply-to-each | ADK **LoopAgent** / Instruction | **A/T** | Deterministic loop → `LoopAgent(max_iterations)` if code path; else NL |
| 9 | Variable (topic/global) | ADK session state / `output_key`; or drop in no-code | **T/X** | System vars mostly have no GE equivalent (drop + flag); user vars → state |
| 10 | Prebuilt entity | OpenAPI param type | **T** | Map type (Email→string+format, Number→number…) |
| 11 | Custom entity (closed list / regex) | OpenAPI enum / pattern, or validation in tool | **T/M** | Closed list → enum; regex → pattern (dialect differs .NET/JS→OpenAPI); flag unsupported |
| 12 | **Agent flow / Workflow** | **ADK workflow agent** (Sequential/Parallel/Loop) or Application Integration | **A/M** | Power Automate JSON → ADK code. Node-by-node reimplementation; connector actions re-mapped one by one |
| 13 | Connector action (M365/3rd-party) | GE connector / Workspace tool / OpenAPI function | **T/M** | Direct where a GE connector exists (SharePoint→Drive?, Outlook→Gmail?); else custom OpenAPI tool. Semantic gaps |
| 14 | **MCP tool** | GE **MCP** (custom MCP server / actions) | **D/T** | Cleanest mapping — MCP↔MCP. Re-point server config; "tools"→"actions" naming |
| 15 | REST/OpenAPI action | GE **function calling** (OpenAPI) | **D** | Near 1:1 — OpenAPI on both sides |
| 16 | Prompt action (single-turn) | Subagent / model call | **T** | Prompt template → subagent Instructions |
| 17 | Knowledge: SharePoint | Data store (Microsoft Office / Drive connector) | **T/M** | Re-ingest into Discovery Engine data store; re-index; permissions remap |
| 18 | Knowledge: public website | Grounding with Google Search / website data store | **T** | Re-add URLs to data store or enable search grounding |
| 19 | Knowledge: Dataverse / enterprise connector | Custom connector → Discovery Engine data store | **A/M** | No direct connector; build custom ingestion. Significant effort |
| 20 | Content moderation / ungrounded settings | GE grounding / safety settings | **T/M** | Map moderation level → GE safety; not 1:1 |
| 21 | Auth: Entra ID / OAuth2 | GE `authorizationConfig` / `authorizations` (clientId/secret/authUri/tokenUri) | **T** | Re-create OAuth authorization resource; identity model differs (Entra→Google) |
| 22 | Human-in-the-loop approval | GE Inbox approval / draft-confirm / risk gating | **T/M** | Approval action → GE HITL pattern; no direct object, pattern-level |
| 23 | Trigger: scheduled (Recurrence) | GE **Schedule object** | **T** | Cron/recurrence → frequency+time+timezone+prompt |
| 24 | Trigger: event (Dataverse/SharePoint) | Pub/Sub → Cloud Function pattern | **M** | No declarative event trigger; build event pipeline. Flag |
| 25 | Channels (Teams/WhatsApp/…) | GE surfaces (web/Chat/Chrome/A2UI) | **M/X** | No channel parity; Teams→Chat closest; many drop |
| 26 | Adaptive Card | A2UI component tree | **A/M** | Card JSON → A2UI payload; partial |
| 27 | Child/connected agents | Subagents / A2A agents | **T** | Map to subagent nodes or A2A registration |

---

## 4. The write path (how the tool actually creates the destination)

There is **no no-code import API**. Your tool targets the **code + Discovery Engine REST layer**, not the Designer UI. Two emit targets:

- **ADK code / `root_agent.yaml`** — the declarative, file-based target. YAML fields: `agent_class` (`LlmAgent`/`SequentialAgent`/`ParallelAgent`/`LoopAgent`), `name`, `model`, `description`, `instruction`, `tools[].name`, `sub_agents[].config_path`. Gemini-only; tool code Python/Java; no A2A/LangGraph in YAML yet. This is the cleanest thing to *generate* from a parsed Copilot agent.
- **A2A Agent Card** (`/.well-known/agent-card.json`) — for externally-hosted agents.

### 4.1 End-to-end create sequence (REST)

All write calls need headers: `Authorization: Bearer $(gcloud auth print-access-token)`, `X-Goog-User-Project: PROJECT_ID`, `Content-Type: application/json`. Host: `{us|eu|global}-discoveryengine.googleapis.com`.

1. **Create the App (Engine)** — *v1 OK*:
   ```
   POST /v1/projects/{PROJECT}/locations/global/collections/default_collection/engines?engineId={APP_ID}
   { displayName, dataStoreIds[], solutionType: SOLUTION_TYPE_CHAT|SEARCH,
     industryVertical: GENERIC, appType: APP_TYPE_INTRANET, commonConfig:{companyName} }
   ```
2. **Create data stores + import knowledge** — data store: `POST .../collections/default_collection/dataStores?dataStoreId={ID}` (`displayName`, `industryVertical`, `solutionTypes[]`, `contentConfig`). Import: `POST .../dataStores/{DS}/branches/default_branch/documents:import` with a union `source` (`inlineSource` / `gcsSource` / `bigquerySource` / `cloudSqlSource`…), `reconciliationMode: INCREMENTAL|FULL`, `autoGenerateIds`, `idField`. Set `documentProcessingConfig` (layout/OCR/digital parser + `chunkingConfig.layoutBasedChunkingConfig.chunkSize` 100–500) **at data-store creation** — chunking can't be toggled later.
3. **Author + deploy the agent runtime** — ADK agent → `client.agent_engines.create(agent=…, config={requirements, extra_packages, display_name, description, service_account, min_instances 0–10, max_instances 1–1000, env_vars, …})` → yields `projects/{PROJECT}/locations/{LOC}/reasoningEngines/{RESOURCE_ID}`.
4. **Create OAuth authorizations** (per tool needing user auth) — *note: PROJECT_NUMBER, not ID*:
   ```
   POST /v1alpha/projects/{PROJECT_NUMBER}/locations/{LOC}/authorizations?authorizationId={AUTH_ID}
   { name, serverSideOauth2:{ clientId, clientSecret, authorizationUri, tokenUri, scopes[]? } }
   ```
5. **Register the agent** to the app — *v1alpha/v1beta only; v1 404s*:
   ```
   POST /v1alpha/projects/{PROJECT}/locations/{LOC}/collections/default_collection/engines/{APP_ID}/assistants/default_assistant/agents?agentId={ID}
   ```
   Agent body fields: `displayName` (req), `description` (req, router uses it), `icon` (`{uri}` or `{content}` base64), `languageCode`, `customPlaceholderText`, `starterPrompts[]` (each `{text}` — **only** `text`), `authorizationConfig` (`toolAuthorizations[]` for ADK — tokens in body; `agentAuthorization` for A2A — token in auth header), `sharingConfig.scope` (`RESTRICTED`|`ALL_USERS`), and **exactly one** definition union:
   - `adkAgentDefinition.provisionedReasoningEngine.reasoningEngine` = the step-3 resource path (**only** field — no `toolSettings`)
   - `a2aAgentDefinition.jsonAgentCard` = stringified A2A card (+ optional `cloudMarketplaceConfig`)
   - `dialogflowAgentDefinition.dialogflowAgent`
   - `managedAgentDefinition` = **empty message** (marker only — no instructions/model/tools fields; not your target)
6. **Set schedules** for recurrence-triggered flows (frequency/time/timezone/prompt).

The Copilot Studio agent most naturally becomes: **ADK agent (adkAgentDefinition)** deployed to a reasoning engine, OR an externally-hosted **A2A agent**.

### 4.2 Function/tool emission

Each Copilot tool/connector action → a Gemini `FunctionDeclaration`: `name`, `description` (drives selection), `parameters` (OpenAPI-3.0-subset `Schema`: `type`/`format`/`enum`/`items`/`properties`/`required[]`/`anyOf`/`$ref`), `response`. Control via `toolConfig.functionCallingConfig.mode` = `AUTO|ANY|NONE` + `allowedFunctionNames[]`. In ADK, `OpenAPIToolset(spec_str, auth_scheme, auth_credential)` auto-generates one `RestApiTool` per operation — so a Copilot REST/OpenAPI action maps almost 1:1.

## 4A. Auth & identity mapping (Entra → Google)

- **End-user identity:** Copilot runs on **Entra ID**. Gemini Enterprise uses **Google Identity** or **Workforce Identity Federation (WIF)**. Since the source tenant is Microsoft, expect **WIF against Entra ID** (OIDC/SAML) — critical rule: `google.subject` **must map to the user's email**. This is what makes migrated knowledge ACLs resolve.
- **Tool/connector auth:** Copilot connection references → GE `authorizations` (`serverSideOauth2`, 3-legged, brokered by GE).
- **IAM roles to provision:** `roles/discoveryengine.agentspaceAdmin` (build/manage), `roles/discoveryengine.editor` (write agents/data), `roles/discoveryengine.agentspaceUser` (**end users — needs a separate GE license**), `roles/discoveryengine.viewer`.
- **Governance parity:** VPC-SC, custom org policies, Model Armor (guardrails), document-level ACL identity mapping.

## 4B. Connector mapping (the mechanical 1:1s and the gaps)

Gemini Enterprise ships **70+ connectors** (data ingestion **and**, where supported, transactional actions). High-value source→dest connector mappings:

| Copilot Studio source | Gemini Enterprise connector | Note |
|---|---|---|
| SharePoint Online | **Microsoft SharePoint Online** connector | Direct — re-ingest into data store |
| OneDrive | **Microsoft OneDrive** | Direct |
| Outlook / Exchange mail | **Microsoft Outlook** | Direct |
| Teams | **Microsoft Teams** | Direct (data); channel surface differs |
| Entra ID (identity) | **Microsoft Entra ID** connector + WIF | Identity/ACL sync |
| Dataverse / Dynamics 365 | **Dynamics 365** connector | Partial — entity coverage differs |
| Jira / Confluence | **Jira Cloud/DC, Confluence Cloud/DC** | Direct |
| Salesforce, ServiceNow, Slack, Box, Zendesk, GitHub, Notion, HubSpot… | same-named connectors | Direct |
| Custom / legacy connector | **Custom MCP Server** data store or **custom connector API** | MCP: StreamableHTTP only, ≤100 actions, no VPC-SC/PSC |

Sync model: ingestion (indexed copy) vs federation (query-time); full/incremental/entity/identity syncs (30 min–7 days). This is a **re-ingestion + re-index**, not a data copy — plan for re-indexing time and ACL remap per connector.

---

## 5. Fidelity risks to surface to the user (per migration report)

- **No cross-experience parity** — Copilot's deterministic topic graph cannot be reproduced faithfully in GE no-code; only ADK code approaches it. Every branch/reprompt is a fidelity risk.
- **Power Fx expressions** — no GE equivalent; must be interpreted to NL or code (tier A, review required).
- **System variables & conversation-state semantics** — largely non-portable.
- **Event triggers** — become custom Pub/Sub pipelines (engineering, not migration).
- **Channels** — no parity; expect drop/re-target.
- **Custom entities as inputs** — already limited in Copilot generative mode; map to OpenAPI enums/patterns with dialect caveats.
- **Knowledge re-ingestion** — data is re-indexed in Discovery Engine, not copied; permissions must be remapped Entra→Google identity.

**Recommendation:** classify each source agent as *auto-migratable* (mostly D/T), *AI-assisted with review* (has A-tier topics/flows), or *manual* (heavy event triggers / channel logic / Dataverse knowledge), and route each class through a different pipeline with a per-component fidelity report.

---

## 6. Verified destination schemas (Discovery Engine discovery doc, rev 20260712)

> Authoritative source: `https://discoveryengine.googleapis.com/$discovery/rest?version=v1alpha`. Field names are the REST JSON (camelCase) names the API actually accepts. **`Agent`, `DataConnector`, and `Authorization` have no public `.proto`** — the discovery doc is the only authoritative public artifact for them (no proto field numbers exist). All field/enum names below are confirmed, not inferred.

### 6.1 Agent (`v1alpha`) — write target
- `name`, `displayName` (req), `description` (req), `icon` (`{uri}`|`{content}`), `languageCode`, `customPlaceholderText`, `starterPrompts[]` (`{text}` only), `authorizationConfig` (`toolAuthorizations[]`, `agentAuthorization`), `sharingConfig` (`{scope}`), `observabilityConfig`
- Output-only: `state`, `createTime`, `updateTime`, `rejectionReason`, `suspensionReason`, `deploymentFailureReason`
- Definition union (exactly one): `adkAgentDefinition` | `a2aAgentDefinition` | `dialogflowAgentDefinition` | `managedAgentDefinition`
- **`state` enum (9):** `STATE_UNSPECIFIED`, `CREATING`, `CONFIGURED`, `DEPLOYING`, `DEPLOYMENT_FAILED`, `ENABLED`, `DISABLED`, `PRIVATE`, `SUSPENDED`
- **`sharingConfig.scope` enum:** `SCOPE_UNSPECIFIED`, `RESTRICTED`, `ALL_USERS`
- `adkAgentDefinition` = `{ provisionedReasoningEngine: { reasoningEngine } }` — **only** field
- `a2aAgentDefinition` = `{ jsonAgentCard, cloudMarketplaceConfig?{entitlement, order} }`
- `dialogflowAgentDefinition` = `{ dialogflowAgent }`
- `managedAgentDefinition` = **empty** (marker only)
- `starterPrompts[]` item = `{ text }` — **no** `fullPrompt`

### 6.2 Authorization (`v1alpha`) — create at project/location scope
- `name`, `displayName` (req), `serverSideOauth2`
- `serverSideOauth2` = `{ clientId (req), clientSecret (req), authorizationUri (req), tokenUri (req), scopes[]?, pkceVerificationEnabled? }`

### 6.3 Assistant (`v1alpha`)
- `name`, `displayName` (req, ≤128), `description`, `webGroundingType`, `defaultWebGroundingToggleOff`, `enabledTools` (map<connectorName, `{toolInfo[]}`>), `generationConfig`, `customerPolicy`, `disableLocationContext`
- **There is NO `enabledActions` field** (the `enabledTools` description mentions it, but it doesn't exist). `webGroundingType` **is** present.
- **`webGroundingType` enum (4):** `..._UNSPECIFIED`, `..._DISABLED`, `..._GOOGLE_SEARCH`, `..._ENTERPRISE_WEB_SEARCH`
- `generationConfig` = `{ defaultModelId, allowedModelIds[], systemInstruction{additionalSystemInstruction}, defaultLanguage }`
- `customerPolicy` = `{ bannedPhrases[], modelArmorConfig, dataProtectionPolicy }`

### 6.4 Engine / App (`v1` for create, full schema `v1alpha`)
- `name`, `displayName` (req, ≤1024), `dataStoreIds[]`, `solutionType` (req), `industryVertical`, `appType` (immutable), `commonConfig{companyName}`
- Config union: `searchEngineConfig` | `chatEngineConfig` | `mediaRecommendationEngineConfig` | `similarDocumentsConfig`
- **`solutionType` enum (6):** `..._UNSPECIFIED`, `..._RECOMMENDATION`, `..._SEARCH`, `..._CHAT`, `..._GENERATIVE_CHAT`, `..._AI_MODE`
- **`industryVertical` enum (4):** `..._UNSPECIFIED`, `GENERIC`, `MEDIA`, `HEALTHCARE_FHIR`
- **`appType` enum (2):** `APP_TYPE_UNSPECIFIED`, `APP_TYPE_INTRANET`
- `searchEngineConfig` = `{ searchTier(STANDARD|ENTERPRISE), searchAddOns[](SEARCH_ADD_ON_LLM), requiredSubscriptionTier }`
- `chatEngineConfig` = `{ agentCreationConfig, dialogflowAgentToLink, allowCrossRegion }`

### 6.5 DataStore (`v1alpha`)
- `name`, `displayName` (req, ≤128), `industryVertical` (immutable), `solutionTypes[]`, `contentConfig` (immutable, default `NO_CONTENT`), `defaultSchemaId` (out), `aclEnabled` (immutable), `workspaceConfig`, `documentProcessingConfig`, `startingSchema`, `identityMappingStore` (immutable), `cmekConfig`, `naturalLanguageQueryUnderstandingConfig`, `federatedSearchConfig`, `dataProtectionPolicy`
- **`contentConfig` enum (5):** `..._UNSPECIFIED`, `NO_CONTENT`, `CONTENT_REQUIRED`, `PUBLIC_WEBSITE`, `GOOGLE_WORKSPACE`
- `workspaceConfig.type` enum: `GOOGLE_DRIVE`, `GOOGLE_MAIL`, `GOOGLE_SITES`, `GOOGLE_CALENDAR`, `GOOGLE_CHAT`, `GOOGLE_GROUPS`, `GOOGLE_KEEP`

### 6.6 DataConnector (`v1alpha`) — singleton per Collection
- Core: `name`, `dataSource` (req) | `connectorSourceId`, `entities[]`, `refreshInterval` (req; `0`=realtime), `incrementalRefreshInterval`, `identityRefreshInterval`, `params` (map) | `jsonParams`, `syncMode`, `actionConfig`, `connectorModes[]`, `staticIpEnabled`, `aclEnabled`, `endUserConfig`, `federatedConfig`, `destinationConfigs[]`, `kmsKeyName` (input-only)
- Output-only: `state`, `actionState`, `realtimeState`, `connectorType`, `staticIpAddresses[]`, `egressFqdns[]`, `errors[]`, `lastSyncTime`, `nextSyncTime`
- **`syncMode` enum:** `PERIODIC`, `STREAMING`, `UNSPECIFIED`
- **`connectorModes[]` enum:** `DATA_INGESTION`, `ACTIONS`, `FEDERATED`, `EUA`, `FEDERATED_AND_EUA`
- **`connectorType` enum:** `THIRD_PARTY`, `BIG_QUERY`, `GCS`, `GOOGLE_MAIL`, `GOOGLE_CALENDAR`, `GOOGLE_DRIVE`, `GOOGLE_CHAT`, `GOOGLE_SITES`, `REMOTE_MCP`, `GOOGLE_WORKSPACE`, `NATIVE_CLOUD_IDENTITY`, `THIRD_PARTY_FEDERATED`, `THIRD_PARTY_EUA`, `GCP_FHIR`, `GCNV` (+`_UNSPECIFIED`)
- `actionConfig` = `{ actionParams (map) | jsonActionParams, serviceName, useStaticSecrets, userDefinedScopesMapping, createBapConnection }`

> Corrections applied from earlier drafts: `AdkAgentDefinition` has no `toolSettings`; `StarterPrompt` has only `text`; `ManagedAgentDefinition` is empty; Assistant has no `enabledActions`; Engine `appType` does exist. All caveats from §3/§5 of prior drafts are now resolved against rev 20260712 — re-pull the discovery doc at build time to catch newer revisions.
