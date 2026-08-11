# How CloudFuze Studio Migrate actually works

A complete walkthrough of the built system: what we read out of Copilot Studio, how each
component is detected, how connectors and tools are rebuilt, and exactly what gets created
on the Gemini side.

Everything here is read off the code as it stands, with file/line references. Where a claim
is about **runtime behaviour** rather than code shape, it is marked and cross-referenced to
[verification-ledger.md](verification-ledger.md), which is the only file allowed to say
something is proven.

---

## 0. The one-paragraph version

A customer connects two clouds. We read every Copilot Studio agent out of **Dataverse**
(Microsoft's database behind Power Platform), normalise it into a neutral shape called
**`AgentIR`**, park that in MongoDB, then — in a separate phase — build a **Python ADK agent**
for each one, deploy it to **Vertex AI Reasoning Engines**, register it into **Gemini
Enterprise**, publish, share, ask it a real question, and write a per-agent fidelity report
saying what came across and what didn't.

---

## 1. The two phases, and why they are separate

`server/src/orchestrator.ts` — one function, `runMigration()`, an async generator that
yields progress events.

```
PHASE 1  EXTRACT   Dataverse ──→ AgentIR ──→ Mongo `stagedAgents`     (orchestrator.ts:646)
                                    ▲
                                    └ the staging DB is the ONLY handoff
PHASE 2  INSERT    read staged rows ──→ create / deploy / publish / share / verify  (:803)
```

**Why the split:** extraction is slow and read-only; insertion hits quotas and can fail
halfway. Staging in Mongo means a failed insert run is retryable **without re-reading
Dataverse**. Extraction code never calls Gemini; Gemini code never calls Dataverse.

Both phases run through `mapPool` — bounded-concurrency, not `Promise.all`, so we never
fire unbounded parallel requests at Dataverse or Discovery Engine.

Progress streams to the browser over **SSE** (`ProgressEvent` union in `types.ts:559`:
`log | progress | agent | done`).

A **dry run** (`plan.dryRun`) stops at `orchestrator.ts:780` — everything is extracted,
mapped and reported, and nothing is created in Gemini.

---

## 2. Which credential does what

Four distinct identities. Crossing them is a bug, not a shortcut.

| Purpose | Credential | Why this one |
|---|---|---|
| Read Dataverse / Copilot agents | Microsoft **app-only** (`client_credentials`) | Delegated Dynamics consent triggers `AADSTS65001`. App-only avoids it. |
| Create things in Gemini | Our **Google service account** — direct IAM first, Domain-Wide Delegation as fallback | Customer grants our SA a Discovery Engine role on *their* project. |
| Call a customer's Jira/Confluence/HubSpot at runtime | Customer's own token, in **Secret Manager**, read **inside the container per call** | Never in the instruction — anything in the instruction is extractable by asking the agent to repeat its prompt. |
| Read the customer's SharePoint for indexing | Customer's **Azure App Registration** (`ms_graph` group) | Graph accepts a client secret; SharePoint's own REST API demands a certificate-minted token (`appidacr: 2`), which customers can't produce. |

---

## 3. EXTRACT — what we read from a Copilot agent

Entry point: `extractAgent()`, `services/dataverse.ts:966`.

### 3.1 The one query that gets almost everything

```
botcomponents
  ?$select=name,data,content,componenttype,_parentbotid_value,filedata_name,
           createdon,modifiedon,ismanaged,statuscode,description,
           _modifiedby_value,schemaname
  &$filter=statecode eq 0 and _parentbotid_value eq <botid>
  &$top=1000
```

`botcomponent` is where Copilot Studio keeps every piece of an agent. `componenttype` says
what each row is (`types.ts:15`):

| type | What it is | Where it lands |
|---|---|---|
| **9** | Topics **and** tools — see §3.2 | `TopicIR[]` / `AgentToolIR[]` |
| 10 | Dialog | not read |
| **14** | Uploaded knowledge file (bytes in the `filedata` column) | `KnowledgeSourceIR` |
| **15** | `GptComponentMetadata` — the **real agent instructions** | `AgentIR.instructions` |
| **16** | Knowledge source config | `KnowledgeSourceIR` |
| 19 | Evaluation sets / test questions | **not migrated**, but named in the report (`dataverse.ts:1169`) |

Note `statecode eq 0` — only enabled components. A **second, cheap query** asks for the
*disabled* ones by name (`:984`) purely so the report can say "3 components are switched off
in the source", because a disabled tool and a missing tool look identical when you compare
the two platforms side by side.

### 3.2 The type-9 split: topic vs tool

This is the single most important detection rule in the extractor.

`componenttype 9` is **not** only topics. It also carries every **tool** — connector
operations, MCP servers, connected agents, AI Builder models. They're told apart by the
`kind:` line at the top of the YAML blob:

```ts
// dataverse.ts:577
function isAgentToolComponent(c) {
  return /^\s*kind:\s*TaskDialog\s*$/m.test(c.data || c.content || '');
}
// AdaptiveDialog → topic.  TaskDialog → tool.
```

Before this split existed, "Jira - Get list of issues" was migrated as a **conversational
topic** and counted as one (22 "topics" on an agent that had far fewer), while the actual
operations it called were never recorded — so they could never reach the target, and the
report couldn't say they were lost.

### 3.3 Parsing a tool (`parseAgentTool`, `dataverse.ts:626`)

Regex, not a YAML parse — deliberately. These bodies are Copilot's own dialect; a strict
parse throws on a shape we haven't seen, and throwing means **dropping the whole tool**.

Read per tool:

| Field | From | Meaning |
|---|---|---|
| `kind` | `kind: Invoke*TaskAction` | `connector` \| `mcp-server` \| `connected-agent` \| `ai-builder` \| **`unknown`** (preserved, never dropped) |
| `connectorId` | `connectionReference: <prefix>.shared_jira.<guid>` → `shared_jira` | which product |
| `operationId` | `operationId: ListIssues` | **which operation** — knowing "it uses Jira" is useless, Jira has dozens |
| `description` | `modelDescription` | what Copilot Studio told the author this operation does |
| `displayName` | `modelDisplayName` | model-facing name |
| `outputs` | `- propertyName:` list | declared outputs |
| **`connectionAuthMode`** | `connectionProperties.mode` | **`invoker`** = runs as the signed-in end user · **`maker`** = one shared connection |

`connectionAuthMode` is the access-fidelity field. An `invoker` tool in Copilot shows each
person only what they can already see. We migrate onto one shared service credential — so
every end user inherits that identity's whole view. That's privilege escalation, not a
fidelity gap, and it has to be reported. Field located live 2026-08-07 — ledger §1.6.

### 3.4 Parsing a topic (`parseTopic`, `dataverse.ts:644`)

- Trigger phrases ← `triggerQueries` (deep key search), with a raw-YAML bullet fallback
- Messages ← `activity` nodes, bindings stripped (never emit a bare `{binding}`)
- `usesAiBuilder` ← contains `InvokeAIBuilderModelAction` or `aIModelId`
- `usesAdaptiveCards` ← contains `AdaptiveCard`
- Summary preference order: `modelDescription` → `additionalInstructions` → first message
- `graph` ← `parseTopicGraph(raw)`, the structured behaviour graph (`services/topicGraph.ts`)

**AI Builder resolution** (`:1125`): for topics with `aIModelId: <guid>`, we look the guid up
in `msdyn_aiconfigurations` and pull the **real prompt text**. For Microsoft prebuilt
Dynamics agents this prompt *is* the agent's brain — without it, the migrated agent is an
empty shell. The map is built once per environment and cached.

### 3.5 Knowledge sources

Two origins, merged (`:1102`):
- type 16 → `parseKnowledgeSource` (`:800`)
- type 14 → `parseFileAttachment`, **except** rows that are actually embedded structured
  configs rather than files (`isEmbeddedConfigSource`)

The real type is at **`source.kind`**, not top-level `kind` — top-level is always the
literal `"KnowledgeSourceConfiguration"` for every source. Reading top-level meant every
classic-schema source fell through classification entirely.

**Confluence** needs four separate signals because none is reliable alone (`:864`):

| Signal | Example | Reliability |
|---|---|---|
| Dataverse `description` | `…Confluence items: Engineering, Demo Wiki` | best — comma-separated, usable for CQL |
| `source.skillConfiguration` | `EngineeringDemoWiki_0ioUg9…` | stable, but word boundaries are gone |
| botcomponent `name` | anything the author typed | unreliable |
| `schemaname` | `crf37_Agent.topic.EngineeringDemoWiki_QfXX…` | cross-reference key |

Confluence **space IDs are not in Dataverse at all** — only display names.

One quirk worth knowing: Dataverse sometimes stores a filename already percent-encoded.
We decode **once**, at extraction (`normalizeFileName`, `:925`), or the upload
double-encodes it (`%20` → `%2520`, confirmed live).

### 3.6 Everything else the agent record carries

- **Description** — tried in strict order (`:1151`): CustomGpt component's own `description`
  column → `bot.configuration.content.description` → GptComponentMetadata YAML →
  `bot.description`. **We never synthesise one** from instructions or topics. No description
  in the source = no description in the target. Product decision.
- **Provenance** (`:1056`) — created/modified, `ismanaged`, owner, schema name, and
  **`publishedon`**. That last one is load-bearing: an agent never published in Copilot
  Studio stays a **draft** in Gemini instead of being force-published.
- **Permissions** (`readAgentPermissions`, `:205`) — owner, per-principal shares with
  decoded Dataverse AccessRights, and end-user chat access policy. If we can read the bot
  but not its shares, `readError` is set — **empty shares must never be read as "nobody has
  access"**.
- **`thinContent`** (`:1160`) — no instructions AND no readable topic content AND no
  resolvable AI Builder prompt. Flags a prebuilt agent whose behaviour isn't in Dataverse
  at all and needs manual authoring.

---

## 4. The IR — the contract between the two halves

`AgentIR`, `types.ts:264`. Extraction produces it; mapping consumes it; **neither side
reaches across**.

```
AgentIR
├── sourceId, name, instructions, description
├── capabilities { webBrowsing, codeInterpreter }
├── starterPrompts[]           ← authored, else derived from topic triggers (:1113)
├── topics[]        TopicIR    ← incl. graph, aiPrompt
├── knowledgeSources[] KnowledgeSourceIR  ← incl. classification
├── agentTools[]    AgentToolIR ← connector + operation + auth mode
├── permissions     owner / shares / chat access
├── sourceMetadata  provenance (report only)
├── thinContent / isManaged
└── unmapped[]      ← everything read but not migrated, in plain English
```

`unmapped[]` is the lossless-extraction guarantee in practice: evaluation components,
disabled components, unresolved AI Builder prompts, Adaptive Cards, knowledge plans — each
one written out so the report can name it.

---

## 5. Knowledge classification — deciding how each source is rebuilt

`services/knowledgeClassifier.ts`. Runs at extraction, per source. Output
(`KnowledgeClassification`):

**Strategy** — how it gets re-established:

| strategy | What we do |
|---|---|
| `copy-and-index` | pull the bytes → GCS → `ImportDocuments` into a document data store |
| `recreate` | recreate the pointer (a website data store over the same URL) |
| `reconnect` | wire Gemini's native federated connector to the same source |
| `confluence-crawler` | crawl the named spaces via Confluence REST → GCS → import |
| `dataverse-snapshot` | export a reference table's rows → structured data store |
| `rebuild-as-tool` | live/structured source → becomes an agent **tool**, not an index |
| `manual-review` | no automatic path; a human decides |

Plus `retrievability` (are the bytes even fetchable?), `geminiTarget` (what gets built), and
`automatable` — **true only when no human setup is needed**. Anything else surfaces in the
report rather than quietly half-working.

A file also passes an ingest gate before we promise anything: formats
`txt json md pdf html htm docx pptx xlsx xlsm`, max **200 MB**.

---

## 6. Connectors and tools — the part with the most moving pieces

### 6.1 The registry

`server/src/connectors/registry.ts` — **33 connectors** across CRM, ITSM, dev, chat, storage,
docs, payments, Microsoft. Each entry declares:

- credential fields (what to ask the customer for)
- `baseUrlTemplate` / `authHeaderTemplate` with `{placeholders}`
- **`authKind`** — how a credential becomes an `Authorization` header:
  `bearer` · `basic-userpass` · `basic-raw` · `oauth2-client-credentials` ·
  `oauth2-refresh-token` · `google-service-account`
- `requiredPermissions` + `adminConsentRequired` — a checklist shown before Save

That `authKind` list exists for a specific reason: several connectors originally asked for
an "Access Token". **Customers cannot generate those** (they come from an OAuth exchange)
and they expire in about an hour. So we ask for durable app credentials and mint tokens
ourselves.

### 6.2 Credential groups — ask once, not five times

`CREDENTIAL_GROUPS` (`registry.ts:122`):

| group | serves | one credential is |
|---|---|---|
| `ms_graph` | Teams, SharePoint, OneDrive, Office 365, Planner, Dynamics | one Azure App Registration (`tenant_id`, `client_id`, `client_secret`) |
| `atlassian` | Confluence + Jira | one API token (`base_url`, `email`, `api_token`) |
| `hubspot` | HubSpot connectors | one private app token |

Without grouping, the UI asked for the same Azure app five times and wrote five copies of
the same client secret. Worse — when a later migration turned up another Microsoft
connector, the customer was asked to re-enter credentials they'd already given, when all
that was actually needed was **adding a permission to the app that already exists**.

A connector can still declare its own fields on top of the group's (Dynamics needs
`org_url`), and those stay scoped to that connector — `connectorFieldScope()`
(`connectorCredentials.ts:45`) decides which namespace each field belongs to.

### 6.3 Secret naming, and the tenant bug it fixes

```
studio-enterprise-{appUserId}-{scope}-{field}      ← what we write now
studio-enterprise-{scope}-{field}                  ← legacy, read-only
```

`scope` = the credential group if there is one, else the connector id.

The `appUserId` is there because the group scope **collides whenever two customers share one
Google project**: customer B's save overwrote customer A's Jira token, and B's deployed
agent then read A's credential. Isolation used to rest entirely on every customer having
their own project — an assumption the product enforces nowhere.

**Reading is not the same as writing.** Never recompute an id to read with: credentials
saved before tenant scoping live under the legacy name, and a deployed agent has whatever
id it was built with baked into its spec. `secretIdFor()`
(`connectorToolBuilder.ts:64`) resolves **stored id first**, computed name only as a
fallback. Recomputing would point a working agent at a secret that doesn't exist, and every
tool call would 403 at inference behind a green deployment.

*(Grade: `T` — typechecks, not yet exercised. Ledger §2 rows 1–2.)*

### 6.4 Which connectors does *this* agent get?

`agentConnectorIds()` (`connectorToolBuilder.ts:452`):

```
connectors used by THIS agent
  = every agentTool's connectorId
  + shared_confluence      if any source classified confluence-crawler
  + shared_sharepointonline if any source is a SharePointSearchSource
```

Wiring all nine configured connectors onto an agent that references three gave it **live API
access to systems its Copilot original never touched**. The wired tools and the instruction
text are both scoped by this same set, because telling the model about tools that don't
exist is worse than saying nothing.

### 6.5 How a connector becomes a callable tool

The current path (`buildLiveConnectorSpecsDetailed`, `:177`) passes **secret IDs only** —
never values — into the deployment spec. The container resolves the actual credential from
Secret Manager **on every call**.

There is a `@deprecated` older function still in the file (`:296`) that embedded credentials
in the agent instruction. It was wrong twice over, and the comment says why:
1. **It can't work.** Telling a model "call this URL with this bearer token" gives it no
   HTTP capability. Best case it narrates a curl command; likely case it hallucinates a
   response and reports it as real data.
2. **It leaks.** Anything in the system instruction comes back out if you ask the agent to
   repeat its instructions — this published customer API tokens, and an Azure client secret,
   to every user of an org-wide agent.

A connector the registry has never heard of is returned in `unsupported[]` and becomes a
**`lost` FidelityNote**, rather than a line in the server log nobody reads.

### 6.6 What the tools actually are, in Python

`server/scripts/adk_deploy.py`, `_build_live_connector_tool()` (`:71`). Purpose-built tools
where it matters, generic REST otherwise:

| kind | Tools |
|---|---|
| `sharepointonline` / `onedrive` | `sharepoint_list_files`, `sharepoint_read_file` (`:294`, `:326`) |
| `jira` | `jira_search` (JQL), `jira_get_issue`, `jira_list_projects` (`:408`–`:518`) |
| `confluence` | `confluence_live_search` (`:561`) |
| everything else | `call_external_api(path, method, body)` driven by the registry templates (`:613`) |

SharePoint gets purpose-built tools for two reasons stated in the code: **scope** — an app
credential with `Sites.Read.All` reaches every site in the tenant (99 in the test tenant)
while the source agent named exactly one folder, and a tool that *cannot express* a wider
path beats an instruction politely asking it not to wander — and **reading files**, because
Graph returns raw bytes and PDF/docx/xlsx extraction has to happen in the container.

**Tool-name uniqueness** is enforced once, over every tool, at `adk_deploy.py:1058`.
`shared_sharepointonline` and `shared_onedrive` both take the SharePoint path and both
return hardcoded names, so wiring both produced `Duplicate function declaration found:
sharepoint_list_files` and the agent **400'd on every message** (live 2026-08-07). Fixing it
inside each builder just moves the problem to whichever builder is next.

---

## 7. MAP — IR → Gemini agent definition

`services/mapper.ts`. Smaller than you'd expect, on purpose.

**The instruction is the source agent's instructions, verbatim. Nothing else.**
(`mapper.ts:41`.) Not AI Builder prompts, not topic summaries, not synthesized boilerplate.

Topics *are* compiled into followable "Conversation procedures" (`topicsEmit.ts`), but that
compiled text is surfaced as a **`needs-review` FidelityNote**, not appended to the
instruction — mixing topic-derived guidance into the same free-text field as the author's
own words shifts the agent's tone away from what the author wrote.

Appended separately: the **live-connector instruction block** (`:244`, credential-free),
which names each connected system and what it can do. That block exists because listing the
product alone wasn't enough — asked *"how many tickets do we have in Jira?"*, an agent with
a working Jira tool answered *"I cannot provide a live count, please check Jira directly"*
**without calling the tool at all** (live 2026-08-07). A capability sentence is the
difference between a wired tool and a used one.

An optional LLM polish pass exists (`refineWithLlm`) and is **off by default**.

Output: `MappedAgent` — displayName, description, instruction, starter prompts, model
(`gemini-2.5-flash`), tools, grounding data stores, and `fidelityNotes[]`.

---

## 8. INSERT — the full ordered sequence

Per staged agent, in `orchestrator.ts:817` onward. Order matters and is not arbitrary.

```
 1  quota pre-flight                      (:809)  warn up front how many fit today
 2  route to THIS environment's engine    (:834)  targetFor(envUrl)
 3  resolve knowledge → data stores       (:836)  BEFORE choosing a deploy path,
                                                  because the ADK path bakes store
                                                  paths in at deploy time
     ├ Dataverse table snapshots                  → structured data store
     ├ SharePoint federated connectors            → + attach to engine (:916)
     ├ SharePoint via Graph crawl        (:963)   → document data store
     ├ Confluence crawl                  (:1001)  → document data store
     └ uploaded files                    (:1136)  Dataverse bytes → GCS → doc store
 4  idempotency + drift check             (:1058)
 5  build the ADK spec, deploy the Reasoning Engine
 6  register into Gemini Enterprise
 7  publish  (only if the source was published)
 8  share
 9  verify — ask it a real question
10  write the result + fidelity report
```

**Why step 3 comes before the path decision:** the low-code path attaches data stores to an
engine; the ADK path bakes the resource path into `VertexAiSearchTool` **at deploy time**.
Resolving stores late produced agents that reported a knowledge source as "attached" and
could never retrieve from it.

**SharePoint federated connectors** get attached to the engine unconditionally (`:911`) even
though ADK doesn't need it — because the Console-only "Authorize" click that makes them
return real content only becomes reachable once the store is attached to an app's engine,
and Discovery Engine has no REST endpoint for that handshake.

### 8.1 ADK-first, low-code as consolation

Historically low-code was tried first and ADK only when it came back stuck `PRIVATE`. But
**no Gemini Enterprise edition auto-lists an API-created low-code agent** — Business's
"self-serve manual publish button" is a human console click this pipeline never performs.
So the low-code attempt was *always* a wasted agent-creation-quota unit (this project's real
quota is ~7/day, empirically — `docs/SUPPORT-TICKET-AGENT-QUOTA.md`) plus a wasted cleanup
delete. Inverted 2026-08-05. Low-code now runs only if the ADK deploy itself fails, so a
customer still gets *something* rather than a hard failure.

### 8.2 Inside the deployment

One Reasoning Engine per agent, containing:

- **root agent** — name, model, the verbatim instruction, all tools
- **sub-agents, one per Copilot topic** (`adk_deploy.py:1119`) — each with its own name,
  description and instruction. A Copilot topic is a self-contained conversation domain,
  which is exactly what an ADK sub-agent is. They live **inside the one deployment**:
  deploying each topic as its own Reasoning Engine would multiply cost and burn the ~7/day
  creation quota on a single migrated agent.
  Sub-agents inherit the root's tools, so a topic that needs SharePoint can still act.
- **`global_instruction`** — rules that must hold for the root **and** every sub-agent. The
  root's own instruction never reached sub-agents, so a question routed to a topic silently
  escaped the rules.
- **`after_tool_callback`** (`:1105`) — records `{tool, ok}` into `state["_tool_calls"]`,
  bounded to the last 50. This is the only place a tool call can be observed for what it
  was; verification had been scraping the transcript for `function_response` blocks, which
  cannot tell *which* connector answered when an agent has five — so an agent where one tool
  worked and four were broken verified as healthy.
  Both are wrapped in `TypeError` fallbacks: an older `google-adk` that rejects them
  deploys **without** them and emits a warning, rather than failing the migration.
  *(Grade `U` — needs a redeploy to prove. Ledger §2 rows 10–11.)*

Grounding: **one** data store → the built-in `VertexAiSearchTool`. **Two or more** →
hand-rolled, distinctly-named `FunctionTool`s (`_make_search_tool`, `:832`), because
combining `VertexAiSearchTool` instances crashed every query.

---

## 9. VERIFY — the part that is allowed to fail

`services/verify.ts`. Two levels, and the second one is the whole point.

**Level 1** — GET the agent. Retries only on *thrown* network errors (ECONNRESET, timeouts);
a non-OK HTTP status is a definitive answer and is not retried.

**Level 2** — **ask it something.**

This used to return `verified: true` whenever the resource was retrievable. That is how a
migrated agent whose every retrieval failed with `403
discoveryengine.servingConfigs.search denied` still reported **"deployed · shared ·
verified"** (2026-08-07). A verification that cannot fail tells a customer nothing.

Now, for an agent we gave knowledge to (`expectsGrounding`):

| Outcome | Verdict |
|---|---|
| Tool returned an error | **fail** — definitive, whatever the model said around it |
| No tool was called at all | **fail** — "answered without retrieving anything, so the data stores are unproven" |
| Tool ran but returned nothing usable | **fail** |
| Answer text admits it can't reach its sources (regex on `permission denied`, `403`, `cannot access`, …) | **fail** |
| Empty answer | **fail** |
| Tool called **and** returned data | **pass** |

The probe itself changes too. A generic *"what can you help me with?"* is answerable from
the instruction alone, so it passes even when every knowledge source is unreachable. A
grounded agent instead gets: *"Search your knowledge sources and name one specific document,
page or file you can actually see. If you cannot access them, say why."*

---

## 10. Idempotency, drift, and re-runs

- **ADK deployments** are recorded per `(appUserId, envUrl, sourceId, destination)`.
  Reasoning Engine `create` has no name-based dedup of its own, so we check our own record
  first — otherwise a re-run mints a second, billable engine (`:1058`).
- **Drift detection** compares the source agent against a snapshot from the last migration.
  Unchanged source → skip.
- **`forceRedeploy`** exists because drift only knows about the **source**. When the change
  originates on *our* side — a fixed tool name, a newly wired connector, a corrected
  instruction — there was otherwise no way to push it onto an already-migrated agent short
  of editing the Copilot agent to fake a difference (hit repeatedly on 2026-08-07).
- **Knowledge data stores** are cached per file — but the cache is **not trusted blindly**
  (`:1146`). The store may have been deleted since; a stale resource path baked into a new
  deploy produces an agent that reports `mapped` and can never retrieve anything.
- **Persistence is best-effort throughout.** Every repo write checks `isDbConnected()` and
  returns quietly if Mongo is down. The pipeline must run without persistence.

---

## 11. What this does *not* do — stated plainly

- **Indexed knowledge loses source permissions.** Every data store our pipeline creates is
  `aclEnabled: false`, and the flag is immutable. A SharePoint folder restricted to Finance
  becomes readable by anyone who can reach the migrated agent. Proven, ledger §1.3.
- **Per-user connector auth is not preserved.** An `invoker` tool becomes one shared service
  credential. We now *detect* the mode (§3.3); we do not yet act on it. Plan #19/#23.
- **Flows / workflows are out of scope.** Phase 1 is agents only.
- **Evaluation sets, disabled components, Adaptive Cards** — read and reported, not migrated.
- **Prebuilt Microsoft agents** whose logic isn't in Dataverse come across as `thinContent`
  and need manual authoring.
- **Gemini sharing is coarse.** Per-user/group sharing isn't available via API — narrower
  access produces a `PermissionHandoff` (a manual checklist) instead of a silent over-share,
  unless `allowOvershare` is explicitly set.

---

## 12. Where to look next

| Question | File |
|---|---|
| What's proven vs merely written | [verification-ledger.md](verification-ledger.md) |
| What we're fixing and in what order | [production-hardening-plan.md](production-hardening-plan.md) |
| The IR shape | `server/src/types.ts` |
| Extraction | `server/src/services/dataverse.ts` |
| The pipeline | `server/src/orchestrator.ts` |
| Connector catalogue | `server/src/connectors/registry.ts` |
| What actually runs in the deployed agent | `server/scripts/adk_deploy.py` |
