# Verification Ledger — what is proven, what is only written

Companion to [production-hardening-plan.md](production-hardening-plan.md). That file says
what we intend to build. **This file says what has actually been observed to work, where,
and by what command** — and, just as importantly, what has *not*.

The plan is allowed to contain intentions. This file is not. Every row here must point at
a command someone can re-run and an output line someone can re-read. If a row cannot cite
one, its grade is `U` and it stays `U` until a run says otherwise.

**Why this file exists:** the project's core invariant is *"a 200 is not an answer;
`deployed=true` is not `works=true`."* That invariant has to apply to our own claims about
our own code too, or the fidelity report is honest about the customer's agents while the
plan is dishonest about ours.

## Grades

| Grade | Meaning |
|-------|---------|
| **P** | **Proven live.** Executed against real infrastructure. Command + observed output line recorded below. |
| **T** | **Typechecked only.** `tsc --noEmit` accepts it. It has never executed. Compiles ≠ works. |
| **U** | **Unverified.** Written, not executed, not exercised by any probe. May be wrong in ways a compiler cannot see. |
| **X** | **Disproven** — a run showed it does not do what was claimed. |

`T` and `U` are not failures. They are the honest state of code that has not met reality
yet. Recording them as anything else is the failure.

---

## 1. Facts proven against live infrastructure

All evidence below captured **2026-08-11** unless noted, against project
`studio-enterprise-migration`, engine `gemini-enterprise-17847887_1784788734248`,
impersonating `zara@storefuze.com`.

### 1.1 Toolchain

| Claim | Grade | Command | Observed |
|-------|-------|---------|----------|
| Web typechecks clean | **P** | `cd web && npm run typecheck` | exit 0, no diagnostics |
| Server **app code** typechecks clean | **P** | `cd server && npm run typecheck` | 27 errors, **all 27** matched `^src/spikes/` — zero in app code |
| Server typecheck as a whole is **red** | **P** | same run | 27 errors. Spikes are rule-exempt from strictness but *not* excluded from the tsconfig, so the gate command itself fails. See §4.1. |

The 27 spike errors are pre-existing (`TS6133` unused vars, one stale `AdkKnowledgeStore`
shape in `_fix_missing_adk_knowledge_store.ts`). None are in the three spikes added this
session. This does **not** make `npm run typecheck` pass — it explains why it doesn't.

### 1.2 Gemini Enterprise — `authorizations` (per-user OAuth mechanism)

Command: `cd server && npx tsx src/spikes/_probe_native_connectors_and_auth.ts`

```
─── 1. authorizations (end-user OAuth) ───
  ok  list authorizations
       0 existing
```

| Claim | Grade | Basis |
|-------|-------|-------|
| The `authorizations` collection exists and is reachable in this project | **P** | HTTP 200 on `GET .../locations/global/authorizations` |
| Our service account has list permission on it | **P** | 200, not 403 — per-user tool work is *not* IAM-blocked |
| Nothing is configured yet | **P** | `0 existing` |
| A **create** succeeds, and an agent can consume the token | **U** | never attempted — this is plan item **#26**. Listing an empty collection proves the endpoint exists. It proves nothing about writes. |

### 1.3 ACL preservation — the central Track A question

Command: same probe, §2 and §3.

**Native data connectors already present in this project (7 collections, 6 connectors):**

```
▸ connectortest_1785961359928          dataSource=sharepoint                 state=RUNNING
▸ erik-googledrive_1786356561493       dataSource=google_drive               state=ACTIVE
▸ filefuze-sp-22734671df75             dataSource=sharepoint_federated_search state=ACTIVE
▸ filefuze-sp-d4a33c3a8821             dataSource=sharepoint_federated_search state=ACTIVE
▸ filefuze-testingpermissions-test_…   dataSource=sharepoint                 state=ACTIVE
▸ sharepointconnectortest_1786023277930 dataSource=sharepoint                state=RUNNING
```

**Data stores under `default_collection`: 47 total — 44 `acl=false`, 3 `acl=true`.**

The three with ACLs enabled:

```
• connectortest_1785961359928_file        acl=true  content=CONTENT_REQUIRED
• erik-googledrive_1786356561493_google_drive acl=true content=GOOGLE_WORKSPACE
• sharepointconnectortest_1786023277930_file  acl=true content=CONTENT_REQUIRED
```

| Claim | Grade | Basis |
|-------|-------|-------|
| `aclEnabled: true` is **achievable in this project today** | **P** | three stores have it, observed directly |
| Every store our pipeline creates has `aclEnabled: false` | **P** | all 44 remaining stores are `acl=false`; the naming (`<agentGuid>-file-…`, `<agentGuid>-tbl-…`, `…-web-…`) is our pipeline's |
| The 3 ACL-enabled stores were created by the **native connector** path | **inference, not proven** | each store id is exactly `<connector collection id>_<entity>`, and no other mechanism in this project produces that shape. Strong, but it is a name match — no API field states provenance. Do not cite this as `P`. |
| `aclEnabled` is immutable after creation | **U** | asserted from docs, never tested here. An update attempt would settle it. |
| Native **Atlassian** (Jira/Confluence) ingestion yields `acl=true` | **U** | no Atlassian connector exists in this project. The three proven cases are SharePoint ×2 and Google Drive ×1. **Do not generalise SharePoint's result to Atlassian.** This is the other half of **#26**. |

Note the two `sharepoint_federated_search` connectors produced **no** data store at all —
federated search queries at answer time rather than ingesting. Different mechanism,
different ACL story, not evidence for either side.

### 1.4 Actions — are native connector actions reachable by a migrated agent?

```
─── 4. assistant configuration (actions / tools) ───
  ok  get assistant
       keys: name, displayName, webGroundingType, createTime, updateTime
       webGroundingType: "WEB_GROUNDING_TYPE_GOOGLE_SEARCH"
```

| Claim | Grade | Basis |
|-------|-------|-------|
| The assistant resource exposes **no** `actionList` / `enabledActions` / `toolList` / `tools` field | **P** | probe explicitly checked all four names; only 5 keys returned, none of them |
| Therefore native Actions cannot be attached to a migrated agent | **NOT proven** | absence on *this* resource is not absence from the API. It means we found no path, not that none exists. Correct statement: **"no attachment path found via the assistant resource."** |

### 1.5 Registered agents — `authorizationConfig` in practice

```
─── 5. registered agents ───
       27 agent(s)      … all listed with auth=—
```

| Claim | Grade | Basis |
|-------|-------|-------|
| No agent in this project currently declares `authorizationConfig` | **P** | 27/27 show `auth=—` |
| The field name we must send at registration is `authorizationConfig.toolAuthorizations` | **U** | taken from documentation. **We have no live example to copy.** #26 would produce the first one. |

### 1.6 Copilot side — per-user vs shared connector auth

Command: `cd server && npx tsx src/spikes/_diag_connection_auth_mode.ts`
(run **2026-08-07**, output not re-captured on 2026-08-11)

| Claim | Grade | Basis |
|-------|-------|-------|
| Dataverse records the auth mode as `connectionProperties.mode` inside the componenttype-9 payload | **P (2026-08-07)** | observed in the raw payload dump; `Invoker` = per-end-user, `maker`/absent = shared |
| `connectionAuthModeFrom()` parses it correctly on real payloads | **T** | the regex was written *from* that dump but the parser itself has never been run over the corpus. Re-running the diag proves the field exists; it does not exercise our code. |
| Every Copilot connector records this field | **U** | seen on the agents in one environment. Not a census. |

### 1.7 Connector operation schemas — where the real HTTP call lives

Command: `cd server && npx tsx src/spikes/_probe_connector_operation_schema.ts`
(run **2026-08-11**, tenant `807d6772-…`, env `orga243378d.crm.dynamics.com`)

The question: we extract `connectorId` + `operationId` and discard it. To rebuild the call
we need verb, path and parameters. Four candidate sources probed, cheapest first.

| Source | Result | Grade |
|---|---|---|
| **1.** TaskDialog payload itself | Carries `operationId`, `modelDescription`, `outputs`, sometimes an `inputs` list of bare `propertyName`s. **No verb, no path, no parameter types.** | **P** — insufficient alone |
| **2.** Dataverse `connectors` table | **0 rows** in this environment. First-party `shared_*` connectors do not appear here. | **P** — not a source |
| **3.** Power Apps API, no filter | `400 MissingEnvironmentFilter` — **the token was accepted**; the query was malformed | **P** |
| **4.** Power Apps API + `$filter=environment eq '<id>'` + `$expand=swagger` | **200, with swagger, operationIds matching exactly** | **P** |

Observed in §4, verbatim:

```
ok   shared_confluence — Confluence · 5 path(s) · 5 operationId(s)
     MATCH  GetPages = GET /{connectionId}/ex/confluence/{cloudId}/wiki/api/v2/pages
            params: connectionId:string* (path), cloudId:string* (path)
ok   shared_sharepointonline — SharePoint · 128 path(s) · 141 operationId(s)
     MATCH  HttpRequest = POST /{connectionId}/datasets/{dataset}/httprequest
            params: connectionId:string* (path), dataset:string* (path), parameters:?* (body)
```

| Claim | Grade | Basis |
|---|---|---|
| Connector swagger is reachable with the **app-only token we already mint** (`https://service.powerapps.com` audience) — no new consent | **P** | 200 on two connectors |
| `operationId` extracted from Dataverse is a **key into that swagger** | **P** | `GetPages` and `HttpRequest` both matched, with parameters |
| Swagger yields verb + path + typed parameters + summary per operation | **P** | printed above |
| The path is a **Power Platform proxy path**, not the provider's native API | **P** | `/{connectionId}/ex/confluence/{cloudId}/wiki/api/v2/pages` — `{connectionId}` is a Power Platform connection we will not have at runtime |
| Stripping the proxy prefix yields the provider-native path | **inference** | true for the Confluence pass-through shape (`/wiki/api/v2/pages` is the real Confluence v2 API). **Not** true for SharePoint's `datasets/{dataset}/httprequest`, which is a Power Platform construct with no provider equivalent. Do not assume it generalises. |
| Every connector's swagger is fetchable this way | **U** | two connectors tested, both first-party. Untested: the other 31, and any custom connector. |

**What this settles:** a generic, swagger-driven tool emitter is real — the schema source
exists, is authoritative, and needs no permission we lack. **What it does not settle:**
whether the proxy path can be mechanically rewritten to the provider's own API for each
connector. Confluence looks like a thin pass-through; SharePoint plainly is not. That split
is the argument for a per-connector module layer on top of the generic backbone.

Incidental, worth noting: **both** connector tools found in §1 carry
`connectionProperties.mode: Invoker` — per-end-user auth. Real agents in this tenant are
using the mode we currently flatten onto one shared credential.

### 1.8 Live defects found by code inspection (2026-08-12)

Surfaced by the dual-voice review of [connector-transform-plan.md](connector-transform-plan.md)
and **each one verified directly against the source** before being recorded here. These are
defects in shipped code, not risks in a plan.

| Defect | Evidence | Grade |
|---|---|---|
| **`listStaged` is a cross-tenant read** — filters `{ runId }` only, no `appUserId`. `security-rules.md` names `stagedAgents` explicitly as requiring it; the index in `db/mongo.ts:96` omits it too. | `db/repos/staged.ts:137` read directly | **P** |
| **Custom connectors are silently dropped.** `connectorIdFromConnectionReference` matches `/\b(shared_[a-z0-9_]+)/i` only, so a custom connector yields `connectorId: undefined`; `agentConnectorIds()` never sees it, so it does not even reach `unsupported[]` and **no `lost` FidelityNote is emitted**. | `dataverse.ts:583`, `connectorToolBuilder.ts:452` read directly | **P** |
| **`state["_tool_calls"]` is written and never read.** The after-tool callback records every tool call in the container; nothing in the TypeScript server consumes it. | `adk_deploy.py:1105` writes; `grep -rn "_tool_calls" server/src/` returns **0 hits** | **P** |
| **Extraction truncates at 1000 components.** `extractAgent` uses single-page `dvGet` with `$top=1000`; the paginating `dvGetAll` exists and is not used on this path. Disabled-component listing caps at 100. | `dataverse.ts:971-989` vs `dataverse.ts:388` | **P** |
| **`registry.ts` already records that D5's flagship example is unfixable** — *"Sites.Read.All grants read of EVERY site in the tenant — there is no per-site application permission."* No operation-derived scope calculation changes this. | `registry.ts:691` read directly | **P** |

### 1.8b Step 0 — three of the four fixed and verified (2026-08-12)

| Fix | What changed | Verification | Grade |
|---|---|---|---|
| **Typecheck gate is green** | `server/tsconfig.json` now excludes `src/spikes`. The rules already exempt spikes from strictness; leaving them inside the tsconfig meant the gate the PR checklist names was permanently red on 27 unused-var errors in files nobody is allowed to clean up. | `cd server && npm run typecheck` → **exit 0**, no diagnostics. `cd web && npm run typecheck` → **exit 0**. | **P** |
| **`listStaged` cross-tenant read closed** | `appUserId` is now a **required** parameter, first in the filter — the compiler enforces it, not a reviewer. Read index changed to `{ appUserId: 1, runId: 1, status: 1 }` so the scoping is indexed, not paid for in a collection scan. | typecheck passes with the caller updated (`orchestrator.ts:777`); a missing arg is now a compile error | **P** (compile-enforced) |
| **Custom connectors no longer vanish** | `connectorIdFromConnectionReference` falls back to the middle dot-segment when the id is not `shared_*`. Separately, the per-agent unsupported report now derives from **the agent's own connectors checked against the registry**, not from `savedConnectors` — the previous list could only ever contain connectors the customer had already configured, so a custom one was absent from it and reported nowhere. | `npx tsx src/spikes/_test_connector_id_parsing.ts` → **6/6 passed**, including the two real payloads captured live on 2026-08-11 (no first-party regression) | **P** |
| **Extraction no longer truncates** | Five `$top`-capped reads now follow `@odata.nextLink`: agent components (was 1000), disabled components (100), `knowledgeConnectorScan` (500/chunk), `thirdPartyConnectorScan` (100 flows), and the SharePoint listing (200/page - it *typed* `@odata.nextLink` and ignored it). `sharePointMigrator`'s `MAX_FILES=500` budget stays but now reports itself as a `skipped` entry instead of passing for a complete copy. | `npm run typecheck` exit 0; 23/23 vitest pass. **No tenant here is large enough to page**, so the paging loop itself is unexercised. | **T** |

The custom-connector fix landing *before* the connector census is deliberate: the census
counts `connectorId × operationId` using that same parser, so running it first would have
measured the blind spot and filed the output as evidence.

Note the honest limit on the parsing test: it re-implements the function rather than
importing it, because the function is private to `dataverse.ts`. If the two drift, the
assertion is worthless. That is the argument for landing `vitest` and importing the real
symbol — the next step-0 item.

### 1.10 Connector × operation census — what the tenant actually uses (2026-08-12)

`npx tsx src/spikes/_diag_connectors_by_agent.ts <envUrl>`, both accessible environments.

**CloudFuze Migration Test** (`org32322095`, 51 bots) — 12 agents use a connector:

```
Agent1                                  shared_confluence [GetPages], shared_sharepointonline
C2MessageGeneratorAgent                 shared_sharepointonline
Case Enrichment Onboarding Agent        shared_commondataserviceforapps (unsupported)
Case Management Agent                   shared_commondataserviceforapps (unsupported)
Customer Service Copilot Bot            shared_commondataserviceforapps (unsupported)
Customer Service Onboarding Agent       shared_commondataserviceforapps (unsupported)
Enterprise Agent                        shared_hubspotsettingsv2 (unsupported), shared_sharepointonline
HubSpot Agent                           shared_hubspotsettingsv2 (unsupported), shared_hubspotcrm (unsupported)
Migration Knowledge Advisor             shared_confluence, shared_googledrive [11 ops], shared_jira [mcp_JiraIssueManagement]
Shadow Agent & License Governance ...   shared_powerplatformadminv2 (unsupported)
Transformation Agent Chat Bot           shared_commondataserviceforapps (unsupported)
confluence agent                        shared_confluence [GetPages]
```

**filefuze (default)** (`orga243378d`, 14 bots) — 7 agents:
`shared_sharepointonline [HttpRequest]` x5, `shared_confluence [GetPages]` x2.

Two facts fall out, both grade **P**:

1. **Four connectors the tenant really uses are not in the 34-entry registry** —
   `shared_commondataserviceforapps` (5 agents), `shared_hubspotsettingsv2` (2),
   `shared_hubspotcrm` (1), `shared_powerplatformadminv2` (1). The registry has
   `shared_dynamicscrmonline`, `shared_hubspot`, `shared_hubspotcrmv2` instead. The ids
   were guessed from product names; the live ids differ. Hand-registering connectors does
   not converge on what customers actually use.
2. **The most-used connector in this tenant is Dataverse itself**
   (`shared_commondataserviceforapps`, 5 of 12 agents) — exactly the one nobody registered.

`HttpRequest` on `shared_sharepointonline` — the operation the plan's kill list refuses —
is the *only* operation the entire default environment uses. That decision stands, but its
blast radius is now measured: 5 of 7 connector-using agents there.

### 1.11 Swagger coverage — every used operation resolves to a real verb + path (2026-08-12)

`npx tsx src/spikes/_probe_swagger_coverage.ts https://org32322095.crm.dynamics.com`
(38 ids = 8 used live + 34 registry), Power Apps `.../apis/<id>?$expand=swagger`, audience
`https://service.powerapps.com`, using the app-only token we already mint.

```
summary: swagger for 32/38 ids; used operations resolved 23, unresolved 0
no swagger: shared_freshsales, shared_gitlab, shared_http, shared_hubspot, shared_notion, shared_servicenow
```

Every operationId extracted from Dataverse was a key into the swagger, verb and path
included:

```
ok   shared_commondataserviceforapps - Microsoft Dataverse - 93 ops  [NOT in registry]
       hit  ListRecordsWithOrganization -> GET /{connectionId}/api/data/v9.1.0/{entityName}
       hit  UpdateRecordWithOrganization -> PATCH /{connectionId}/api/data/v9.1.0/{entityName}({recordId})
ok   shared_confluence - Confluence - 5 ops
       hit  GetPages -> GET /{connectionId}/ex/confluence/{cloudId}/wiki/api/v2/pages
ok   shared_googledrive - Google Drive - 42 ops        (11 of 11 hit)
ok   shared_jira - Jira - 65 ops
       hit  mcp_JiraIssueManagement -> POST /{connectionId}/mcp/JiraIssueManagement
ok   shared_powerplatformadminv2 - Power Platform for Admins V2 - 189 ops  [NOT in registry]
```

**23 hits, 0 misses.** Grade **P**. This is the load-bearing fact for the connector plan:
turning "Copilot called operation X" into "call this HTTP endpoint" is *mechanical*, not
per-connector guesswork. A generic swagger-driven emitter is buildable, and a new connector
should cost a fixture rather than a module.

Honest limits on that claim:

- The 6 ids with no swagger are all ids **no agent in this tenant uses**. The
  `$filter=environment eq '<id>'` scopes the query to connectors installed in that
  environment, so a 404 means "not installed here", not "no swagger exists".
  `shared_http` differs in kind — the generic HTTP connector has no per-operation schema.
- Resolving an operation to a verb+path is not the same as **calling** it. Auth binding
  (`{connectionId}` — plan step 3b) is unproven, and nothing here was executed against a
  live connector endpoint.
- Both facts come from one tenant. 65 agents is a sample, not a population.

### 1.9 Correction — file bytes are not in the extraction `$select`

An earlier draft of the connector plan asserted that componenttype-14 rows carry uploaded
knowledge-file **bytes**, and used that to justify constraints on raw payload storage. That
is wrong. `dataverse.ts:974` selects `filedata_name`, not `filedata`; bytes are fetched
separately at migration time via `botcomponents(<id>)/filedata/$value` (`dataverse.ts:346`).

The constraints were right; the reason was not. The sensitive payload in a raw component
row is the topic YAML in `data`/`content` — customer business logic and message text.
Recorded here because "we don't copy bytes" would otherwise read as having solved a privacy
problem that lives somewhere else.

---

## 2. Code written this session — none of it executed

`git diff --stat`: **11 files, +800 / −73**, plus 4 new files. Branch `business`,
**22 commits unpushed**, and every change below is **uncommitted**.

| # | Change | File | Grade | What would move it to P |
|---|--------|------|-------|-------------------------|
| 1 | Tenant-scoped secret ids (`appUserId` in the id) + legacy read fallback | `services/connectorCredentials.ts` | **T** | Save creds as two different app users; confirm two distinct secrets exist and neither reads the other's |
| 2 | Stored-secret-id wins over computed id (so already-deployed agents keep resolving) | `services/connectorToolBuilder.ts` | **T** | Resolve a pre-existing agent's secret after the id scheme changed |
| 3 | `upsertSecretIfChanged()` — skip `addVersion` when value unchanged | `services/secretManager.ts` | **T** | Save identical creds twice; confirm version count does not grow |
| 4 | `pruneSecretVersions()` — keep 2, destroy older | `services/secretManager.ts` | **U** | Save 4 times; list versions; confirm 2 enabled |
| 5 | `grantSecretAccessToServiceAgent()` — per-secret IAM | `services/secretManager.ts`, `services/adkDeployer.ts` | **U** | Deploy; confirm `secretIamGranted` true and the container reads the secret |
| 6 | `connectorValidator.ts` — validate-on-save, 5 result codes | new file | **U** | Save one good and one deliberately bad credential; confirm `ok` vs `invalid_credentials` |
| 7 | Save routes merge onto prior record, reuse stored ids, validate on read-back | `routes/migrate.ts` | **U** | Save partial creds; confirm untouched fields survive |
| 8 | `?purge=true` on DELETE, skipping secrets a sibling still uses | `routes/migrate.ts` | **U** | Two connectors sharing a credential group; delete one; confirm the other still works |
| 9 | Fixed: MS route recorded `session.geminiProject` while writing to `secretsProject` | `routes/migrate.ts` | **T** | Real bug, real fix, unexercised |
| 10 | `after_tool_callback` recording bounded `state["_tool_calls"]` | `scripts/adk_deploy.py` | **U** | **Requires a redeploy.** Ask a deployed agent a question; read `_tool_calls` back |
| 11 | `global_instruction` / `globalAnswerContract()` | `adk_deploy.py`, `adkDeployer.ts` | **U** | Same redeploy; confirm the contract changes refusal behaviour |
| 12 | `connectionAuthMode` on `AgentToolIR` | `types.ts`, `services/dataverse.ts` | **T** | Extract a known-Invoker agent; confirm the IR carries `'invoker'` |
| 13 | Unregistered-connector fidelity note | `services/connectorToolBuilder.ts` | **T** | Migrate an agent using an unregistered connector; confirm the note appears in the report |
| 14 | `supplied` flag per field on `/connector-requirements` | `routes/migrate.ts`, `web/` | **U** | No `/qa` run has been done on this UI at all |
| 15 | `ConnectorValidation` surfaced in the UI | `web/src/pages/ConnectorConfig.tsx` | **U** | Same — never opened in a browser |

**Summary: 0 of 15 changes are grade P.** Six are `T` (the compiler has seen them), nine
are `U` (nothing has). The two spikes are the only artifacts of this session that have
produced evidence.

---

### 1.12 Source and tool SHAPES — what agents are actually made of (2026-08-12)

`npx tsx src/spikes/_diag_source_and_tool_shapes.ts`, both environments, read-only.

**Knowledge sources — 29 total, every one scoped to a sub-resource, not a whole system.**

Copilot stores them all as `KnowledgeSourceConfiguration`; the *scope* lives in the
generated description and the config body:

```
"...answers questions found in the following Confluence items: Engineering, Demo Company Wiki"
"...answers questions found in the following Dataverse items: CF ICP Profile, FAQ Entry"
"...provides information found in daily_queries.txt SharePoint."
siteUrl=https://filefuze-my.sharepoint.com/personal/erik_filefuze_co/Documents/HR%20Neutara%20Poli…
"...searches information on the web found in https://lookup.icann.org website"
```

So the unit an author picks is a named space, a named table, a named file, a specific
folder path, a specific site — never "all of SharePoint". Grade **P**. Fidelity
consequence: a strategy that indexes a whole site or a whole drive when the author named
one folder does not preserve the agent, it enlarges it. Scope narrowing is a correctness
requirement, not an optimisation.

**Tools — 63 TaskDialogs, and only two thirds are connector calls.**

| Action kind | Count | What it is |
|---|---|---|
| `InvokeConnectorTaskAction` | 43 | A connector operation — the only kind `operationBinding.ts` covers |
| `InvokeAIPluginTaskAction` | 8 | An AI plugin / custom API the author added in Copilot |
| `InvokeExternalAgentTaskAction` | 6 | An **MCP server** (e.g. Jira MCP, with an explicit tool allow-list) |
| `InvokeFlowTaskAction` | 3 | A Power Automate flow, identified only by `flowId` |
| `InvokeConnectedAgentTaskAction` | 2 | Another Copilot agent |
| `InvokeAIBuilderModelTaskAction` | 1 | An AI Builder prompt (already resolved by `buildAiPromptMap`) |

`with modelDescription: 54/63 · with operationId: 49/63 · with input bindings: 37/63`

**The plan's step-3b fear is disproven: the author's bound arguments ARE in the payload.**

```yaml
inputs:
  - kind: ManualTaskInput
    propertyName: entityName
    value: msdyn_transformationjobs
  - kind: ManualTaskInput
    propertyName: "'$filter'"
    value: =Concatenate("statecode ne 1 and … msdyn_telephonenumber eq '", Global.SelectedPhoneNumber, "'")
  - kind: ManualTaskInput
    propertyName: "'$top'"
    value: 1
action:
  kind: InvokeConnectorTaskAction
  connectionProperties: { mode: Invoker }
  operationId: ListRecordsWithOrganization
```

Two input kinds: `ManualTaskInput` (the author fixed the value) and `AutomaticTaskInput`
(the model fills it, with an entity type). Together with the `outputs` block and
`dynamicOutputSchema` — which types the result down to individual columns — this is enough
to reproduce the call, not merely a call of the same shape. Grade **P** for the payloads
being present and parseable.

The honest limit: `ManualTaskInput.value` can be a **Power Fx expression** referencing
runtime state (`Global.SelectedPhoneNumber`, `Concatenate(...)`). A literal migrates
directly; an expression needs either a Power Fx subset evaluator or demotion to a
model-supplied argument with a `needs-review` note. It must not be copied through as
literal text — that produces a filter string containing the word `Concatenate`.

`connectionProperties.mode: Invoker` on both sampled connector tools. Per-user auth is the
normal case in this tenant, not the exception — which raises the priority of D7.

**What we extract today vs what is there:** `modelDescription`, `operationId`,
`connectorId`, `connectionAuthMode` and `outputs` are extracted (`dataverse.ts:637`).
`inputs`, `dynamicOutputSchema`, the MCP tool allow-list, `flowId` and the AI-plugin
identity are **not**. They are in the payload we already hold — this is an extraction gap,
not an access problem.

---

### 1.13 The binding extractor, run over every live tool (2026-08-12)

`npx tsx src/spikes/_test_tool_payload_parser.ts` — parses every TaskDialog in both
environments with `services/toolPayload.ts` and reports what it recovered.

```
TaskDialogs parsed          63
  with input bindings       37
    fixed arguments         109   (of which Power Fx expressions: 19)
    model-filled arguments  26
    unrecognised kinds      0
  with output schema        25  (292 fields total)
  MCP servers               6  (allow-listed: 1, no list stated: 5)
  Power Automate flows      3
  AI plugins (custom API)   8
```

63 of 63 tools parsed, **0 unrecognised input kinds**, and the tool count matches the
independent census in §1.12 exactly. Grade **P** for extraction.

What that buys, concretely: 109 arguments the author pinned are now recoverable instead of
being re-invented by the model, and 292 declared output fields can be described to it.

Two numbers that are warnings rather than wins:

- **19 of 109 fixed arguments are Power Fx expressions**, not literals. They reference
  runtime state (`Global.…`, `Concatenate(…)`) that does not exist on the Gemini side.
  Copying one through would send the word `Concatenate` to the vendor. `isExpression`
  flags them so a caller cannot mistake one for a literal; deciding what to DO with them
  (evaluate a Power Fx subset, or demote to a model-supplied argument with a
  `needs-review` note) is not yet implemented.
- **5 of 6 MCP servers state no tool allow-list.** The parser reports `unknown` rather
  than widening to `all`, because migrating an MCP server without its list would give the
  migrated agent MORE tools than the source had. Whether Copilot stores the list elsewhere
  for those five is unanswered.

### Correction — a probe truncated itself

The first run of this spike reported `TaskDialogs parsed 42`. It read one page and no
`@odata.nextLink`, exactly the bug class fixed in the pipeline hours earlier. It was caught
only because 42 contradicted §1.12's 63. Recorded because the ledger's own instruments are
not exempt from the errors it exists to catch, and because two independent counts
disagreeing is what made it visible.

---

### 1.14 Per-customer connector capture works, including connectors we never shipped (2026-08-12)

`npx tsx src/spikes/_test_capture_op_index.ts`

```
env CloudFuze Migration Test (7f9f87cc-…)  scope ms-807d6772-…

shared_confluence        live capture: 5 ops (Confluence)   2406ms
                         resolve:      5 ops                   5ms (cache hit)
shared_bitbucket         live capture: 20 ops (Bitbucket)   1098ms
                         resolve:      20 ops                  7ms (cache hit)
shared_notaconnector     live capture: not available         977ms
                         resolve:      undefined

cached rows for this customer: shared_bitbucket=20, shared_confluence=5
offline fallback (no ctx):    5 ops from fixture
```

Grade **P**. The load-bearing row is `shared_bitbucket`: **20 operations captured for a
connector this repo ships no fixture for**. Coverage is no longer limited to what CloudFuze
happened to capture — a customer's own environment answers for the connectors a customer
actually installed. A connector that does not exist there returns undefined rather than an
error, and with no context at all the committed fixture still answers offline.

Cache hits are 5–7 ms against 1–2.4 s for a live capture, and the cache is keyed by
`{credentialScope, environmentId, connectorId}` with a 14-day TTL — a stale index would
describe paths a connector no longer has, and that failure would surface at inference as a
404 with nothing pointing back here.

Still hand-maintained, and honestly so: `VENDOR_BINDINGS` says where a vendor lives and what
credential it wants. Bitbucket's operations are now captured but it has no binding entry, so
readiness reports `unknown-connector` with a reason rather than inventing a host.

### 1.15 Secret isolation was nominal — measured, not suspected (2026-08-12)

`npx tsx src/spikes/_diag_secret_scoping.ts`

```
migrationSessions:     default=2
connectorCredentials:  default=10
adkDeployments:        default=5
stagedAgents:          default=93
distinct Microsoft tenants seen: 1
distinct Google projects seen:   1
  cred default / shared_jira       -> studio-enterprise-atlassian-api-token @ studio-enterprise-migration
  cred default / shared_confluence -> studio-enterprise-atlassian-api-token @ studio-enterprise-migration
```

Every row in every scoped collection is `appUserId: 'default'`, because no route sets it —
sign-in was never wired. And every stored secret id is the **legacy un-scoped** name, since
`priorRecord.secretIds` reuse keeps an id alive once written. Grade **P** for the finding.

With one customer this is harmless, which is why it survived. With two customers on one
deployment it is a shared credential namespace: B's Atlassian token overwrites A's, and A's
deployed agent then calls Atlassian with B's credential. `appUserId` appearing in every
filter and every secret id reads like isolation and provided none.

Fixed in `b75d838`: `credentialScope(session)` prefers `appUserId` and falls back to the
Microsoft tenant id (a real discriminator, from the OAuth flow, already on the session); the
owner parameter on `connectorSecretId` is now required, and the compiler immediately caught
a caller that had been relying on the silent legacy fallback; purge verifies ownership
labels before destroying anything.

**Still open (§4.5):** the Mongo scope key is unchanged, so per-collection `appUserId`
filters remain a no-op until sign-in lands or the collections are re-keyed.

---

### 1.16 A migrated agent reproduced a Copilot call — end to end (2026-08-12)

The claim this whole plan has been building toward, and the first time it is grade **P**.

**Step 1 — the binding produces a working request.** `_test_bound_call.ts` builds the specs
exactly as the deploy path does and issues the request from Node with the customer's stored
credentials, so a failure is attributable to the binding rather than to the container:

```
── get_pages  (shared_confluence GetPages)
   GET https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2/pages
   context: cloudId  auth=atlassian-basic
   resolved cloudId from https://cf2020.atlassian.net/_edge/tenant_info: ok
   -> 200 OK  {"results":[{"authorId":"712020:…","createdAt":"2025-03-17T16:29:22.706Z",…

── list_companies  (shared_hubspotcrm CompaniesList)
   GET https://api.hubapi.com/crm/v3/objects/companies
   model:   limit, properties, archived
   -> 200 OK  {"results":[{"id":"9618496085","properties":{"name":"Thai Otsuka",…

── get_api_usage  (shared_hubspotsettingsv2 GetTheDailyApiUsageAndLimitsForAHubspotAccount)
   GET https://api.hubapi.com/account-info/v3/api-usage/daily
   -> 404 FAILED
```

**Step 2 — deployed, and the tool actually fired.**

```
Confluence_agent  -> reasoningEngines/7686282818770436096  ENABLED  secretIam=true
  Q: Use your Confluence tool and list the titles of a few pages you can see.
  A: Box to OneDrive DOC.pdf / Getting started in Confluence / 2. Engineering Notes /
     4.1.1.1 Level 3 — API Documentation
  toolCalled: true   toolSucceeded: true

HubSpot Agent     -> reasoningEngines/6830598889570041856  ENABLED  secretIam=true
  Q: Use your HubSpot tool to list a few company names.
  A: Thai Otsuka, NOS, Advent Health Group, arizk822, REFUELS
  toolCalled: true   toolSucceeded: true
```

Those page titles and company names are live vendor data, not indexed knowledge and not
model invention — `toolSucceeded` is set only by a non-error `function_response`. The chain
that produced them is: Dataverse payload → operationId + author's bound arguments → the
customer's own swagger → vendor URL → typed ADK function tool → 200 from Atlassian/HubSpot.

**The 404 is kept, not hidden.** `GetTheDailyApiUsageAndLimitsForAHubspotAccount` resolves
to a real path from the swagger and HubSpot answers 404 for it with a private-app token.
So a resolved verb+path is NOT the same as a working call, exactly as §1.11 warned. That
operation is deployed as a tool that will report its own failure rather than being silently
dropped, and it is the argument for plan step 6 (per-operation validation before the
capability report).

**Two credential-plumbing gaps found by doing this, both fixed:**

- The HubSpot Agent uses `shared_hubspotcrm` while the stored record is
  `shared_hubspotcrmv2` — the same private app token, one credential group. Nothing
  inherited it, so the connector was treated as unconfigured and no tool was built. Secret
  ids now fall back to a credential-group sibling's stored id, and the orchestrator expands
  configured connectors to their group siblings.
- `shared_hubspotcrm` and `shared_hubspotsettingsv2` had no registry entries at all (they
  are the ids agents actually use — §1.10), so they were reported unsupported. Added.

**Honest limits.** Two agents, three operations, two vendors, one tenant. Both are GET
operations with no fixed arguments; the Power Fx demotion path and the Dataverse
`aad-token` path are written and typechecked but have not run in a deployed agent.

---

### 1.17 Dataverse: connector calls live inside TOPICS, and two of our instruments disagreed (2026-08-12)

Going after the Dataverse agents surfaced three things, in the order they were found.

**a) Extraction was blind to the way these agents work.** The census said `Case Management
Agent` uses `shared_commondataserviceforapps` with six operations. `extractAgent` reported
**0 tools** for it. One of them was wrong, and it was extraction:

```
bot Case Management Agent — 12 components, all type=9 statecode=0 managed=true
[AdaptiveDialog] Resolve a case      actions: InvokeConnectorAction  ops: ListRecordsWithOrganization, PerformUnbound…
[AdaptiveDialog] Initialize agent    actions: InvokeConnectorAction  ops: PerformUnboundActionWithOrganization
[AdaptiveDialog] Apply Routing Rules actions: InvokeConnectorAction  ops: PerformUnboundActionWithOrganization
```

The connector call is a STEP INSIDE A TOPIC (`kind: InvokeConnectorAction`), not a
standalone `TaskDialog` tool. `isAgentToolComponent` only accepted TaskDialog, so five
Microsoft Customer Service agents — the largest connector group in the tenant — looked
toolless. After `parseTopicConnectorActions`: **0 → 15 tools**, each with its bound
arguments and its owning topic. Grade **P**.

The argument shape differs too: `input.binding` is a map, not a list of typed input
records. That is exactly the "every customer's payloads differ" case the parser was written
scanner-style for.

**b) A bug in my own refusal rule, caught by running it.** Topic bindings QUOTE their
Power Fx:

```yaml
item: "={msdyn_AutomationLevel: Topic.automationLevel, msdyn_Entity: Topic.incidentEntity, …}"
$filter: ="_msdyn_incidentid_value eq '" & Topic.incidentId & "' and statecode eq 0"
```

`value.startsWith('=')` is false for the first one — it starts with `"`. So the strictest
rule in the pipeline ("never copy Power Fx through as a literal") silently did not fire, and
the migrated tool would have POSTed the formula text as a request body. Fixed by unquoting
first. Recorded because the rule looked correct in review and only its execution exposed the
hole.

After the fix, for that one agent: **3 operations refused outright** (`entityName` /
`recordId` computed at run time and required — a tool that silently queries the wrong table
is worse than no tool) and **18 arguments demoted** to model-supplied with `needs-review`.
The pinned parts survive: `actionName=msdyn_SetAIAgentStatus`, `organization=current`.

**c) The Dataverse call itself is blocked on a customer grant, not on code.**

```
── resolve_a_case_listrecordswithorganization
   GET {dataverseOrgUrl}/api/data/v9.1.0/{entityName}
   context: dataverseOrgUrl  auth=aad-token
   -> 403  {"error":{"code":"0x80072560","message":"The user is not a member of the organization."}}
```

The Entra token minted successfully — the `aad-token` path works. Dataverse then refused it
because the app registration is not an **application user** in that environment. That is a
prerequisite the customer grants (Power Platform admin → Environment → Application users →
New), and it is now stated in the connector's `permissionsHint` so it appears in the UI
before a run rather than as a 403 at inference.

**What this says about the Microsoft prebuilt agents.** Their logic is choreography: topics
decide when to call, in what order, with values computed from conversation state. Extracting
the calls preserves the CAPABILITY; the sequencing does not survive, and the report says so
per tool. An honest migration of these agents is "here are the actions it could perform",
not "here is the same agent".

### 1.18 The first run through the actual browser UI — three things only the UI could show (2026-08-12)

Everything before this was proven through spikes. Driving the real wizard
(Connect → ChoosePair → MapUsers → SelectMap → SelectAgents → ConnectorConfig → Migrate)
against `localhost:5173` found three defects the pipeline tests could not, because all
three live between the server's answer and what the customer is shown.

**a) The readiness panel never rendered for the connectors we actually migrate.** The
server computes it and returns it:

```
POST /api/migrate/knowledge-connectors  (Confluence_agent)
shared_confluence | readiness: {"bindable":["GetPages"],"blocked":[],"ready":true}
```

`ConnectorConfig.tsx` renders `<ReadinessPanel>` inside `ConnectorCard` (standalone
connectors) but **not** inside `GroupSection` — and every connector that shares a
credential group goes through `GroupSection`. Atlassian and HubSpot are both groups, so
the two connectors this project has proven end to end were exactly the two whose
readiness was silently dropped. `ReadinessPanel` returns `null` on absent readiness, so
there was nothing on screen to notice. Fixed by rendering `OperationList` +
`ReadinessPanel` per member, in both the saved and unsaved states — readiness is a claim
about the operations, not about the token. Proven live after the fix:

```
🟠 HubSpot (one private app token) | Used by: HubSpot Settings V2, HubSpot CRM — HubSpot Agent
   Operations used: GetTheDailyApiUsageAndLimitsForAHubspotAccount
   The one operation this agent uses maps to HubSpot Settings V2's own API.
   Operations used: CompaniesList
   The one operation this agent uses maps to HubSpot CRM's own API.
📝 Atlassian (one API token) | Used by: Confluence — Confluence_agent
   Operations used: GetPages
   The one operation this agent uses maps to Confluence's own API.
```

Grade **P**.

**b) A dry run claimed an acknowledgement nobody gave.** The ACL gate deliberately does
not stop a dry run (it writes nothing, and the dry run is how someone discovers the loss
in the first place). But the code past the gate assumed it had been acknowledged:

```
06:07:23  Permission loss acknowledged for 1 agent(s) — proceeding. Each affected
          source is recorded in the fidelity report.
```

Nothing was acknowledged — no gate was ever shown. The fidelity note carried the same
claim ("This was explicitly acknowledged before the migration ran"), which is worse: the
log scrolls away, the report is what someone reads six months later to decide whether the
permission loss was accepted. Both now branch on `plan.acknowledgeAclLoss`. Proven live:

```
06:11:42  1 agent(s) would lose source permissions. A live run stops here until this is
          acknowledged; each affected source is listed in the fidelity report.
```

Grade **P**.

**c) A refresh turns "we could not tell" into "there is nothing".** The selected agents
live only in `sessionStorage.csge_data_<session>`. Reloading `/connector-config` directly
produced:

> No outside connections found for the agents you selected — they only use built-in
> Microsoft features and don't rely on any external service.

for two agents that provably use Confluence and HubSpot. The scan ran over an empty set
and the empty result was reported as a positive finding. Not fixed here (the fix is to
carry the selection on the server plan, which is a state change, not a copy change) —
recorded as **X** against the claim that the connector step is safe to reload.

**What the run also confirmed, positively.** Both clouds reconnected from the stored
session; 286 Microsoft users listed; 51 + 14 agents enumerated across two environments;
3 connectors detected for the 2 selected agents with credentials remembered from the
earlier work; dry run staged 2/2 and reported `Confluence_agent 2 auto / 5 needs review`,
`HubSpot Agent 1 auto / 3 needs review` with nothing created in Gemini. One click produced
exactly one run (`── Phase 1` appears once per click) — an apparent double-run in an
earlier attempt was my own double navigation, not the product.

**A contradiction I reported and was wrong about.** I flagged `detTools=0` against the
connector step's 3 detected connectors as the same instrument disagreement as §1.17a. It
is not one. `detTools` is `deterministicTools` from the topic compiler
(`topicsMigration.ts:351`): `c.tools.filter((t) => t.requiresWorkflow).length` — tools
found INSIDE topics that need a Cloud Workflow. It never counted connector tools.
Confluence_agent uses Confluence as a knowledge source and HubSpot Agent's calls are
standalone TaskDialog tools, so `0` is right for both. Recorded because the lesson from
§1.17a — two counts disagreeing means one instrument is wrong — does not apply when the
two counts were never measuring the same thing, and I should have read the emitter before
raising it.

**And the login page is not a login page.** `web/src/pages/Login.tsx` POSTs to
`/api/login`, which does not exist; anything other than a 401 proceeds, so any input
signs in. `verifyLogin` in `db/repos/users.ts` is written and unused. This is §4.5's
launch blocker seen from the front: multi-tenant isolation cannot be real while the
identity is unauthenticated. Grade **X** against "the app has sign-in".

### 1.19 Copilot agent memory: what it is, and proving it has somewhere to land (2026-08-12)

Memory was a feature we had never looked at. Before deciding how to migrate it, three
questions had to be answered with data: what is it, can it be scoped to an agent, and does
the destination have anywhere to put it.

**a) What Copilot stores.** Two tables, both present in the customer's environments and
both **empty** — nobody in this tenant has used the feature yet:

```
═══ intelligentmemory
  memorykind      String   The category of information being persisted - fact, observation, inference etc.
  memorysource    String   The source creating the memory record - app, agent, user etc.
  memorytype      String   short_term, long_term
  predicate       String   '_' separated strings that represent the relationship/characteristic
  privacylevel    String   Private (user-only), Shared (specific a…
  subject         Memo     The subject/entity that the memory is about.
  targetobject    Memo     The information about the subject that is being persisted.
  ttlinseconds    Integer  Time to live in seconds.
  ── lookups: (none beyond ownership)

═══ agentmemory
  agentid, sessionid, agenticscenario, promptid, agentinput, signals, data, ttlinseconds
  ── lookups: agenticscenario→agenticscenario
```

`intelligentmemory` is a **semantic triple store about people** — subject / predicate /
object, with a per-fact privacy level and expiry. `agentmemory` is per-session scratch
with a TTL. Grade **P** for the schema; **P** for "empty in this tenant".

**b) Memory has no agent.** `intelligentmemory` carries **no relationship to `bot`** —
only a free-string `sourceid`. Copilot remembers things about a PERSON, not about an
agent. This is the fact that shapes the whole design: a memory can be attributed to a
migrating agent only when `sourceid` happens to equal that agent's botid, and everything
else must be reported rather than attached to whichever agent was migrating at the time.
`attributeMemory()` does exactly that and nothing looser.

**c) The destination can hold it — proven, not assumed.** Vertex AI Agent Engine's Memory
Bank hangs off a reasoning engine, and our migrated agents already are reasoning engines.
Against the live `Confluence_agent` engine with the service account we already have:

```
1. CREATE  -> 200 .../memories/4058335694869757952/operations/1087890172122497024
   operation done -> .../memories/4058335694869757952
2. LIST    -> 200  1 memory(ies)   fact="The user prefers weekly summaries delivered on Monday mornin"
3. RETRIEVE-> 200 { "retrievedMemories": [ { "memory": { … "fact" …
4. DELETE  -> 200
```

Grade **P**. Create → list → retrieve → delete, all 200.

**d) The full step, end to end, through the functions the pipeline calls.** Four
synthesized facts in the Dataverse shape (no customer memory content anywhere in this
repo), one of them deliberately private with an unmappable subject:

```
1. READ real environment memory
   -> 0 fact(s); attributed to migrating agents: 0; unattributed: 0
2. MIGRATE (4 synthetic facts, one deliberately unmappable & private)
   written: 3/4
   note [needs-review] memory:reports_cadence: Copilot would have forgotten this on 2026-08-12
        (TTL 172800s). Memory Bank has no per-memory expiry, so it now persists until deleted.
   note [lost] memory:salary_band: Remembered detail about "unmapped@nowhere.example" was not
        migrated: it is marked Private (user-only) in Copilot and its subject has no mapped…
   note [needs-review] memory:renewal_month: Recorded as an inference — something Copilot's
        model concluded, not something the user stated…
3. RETRIEVE as the agent would
   "probe@dest.example prefers contact channel: email, not chat"
   "probe@dest.example reports cadence: weekly on Monday"
   private-unmapped fact leaked into the shared scope? no
   [shared] "acme corp renewal month: March"
4. DELETE everything created -> 200, 200, 200
```

Grade **P** for the write/retrieve/refusal behaviour. **U** for migrating a REAL Copilot
memory, and it will stay U until a tenant that has actually used the feature runs through
it — the extractor is proven to read the table and return 0, not to parse a populated row.

**The three rules the mapping enforces, and why.**

- **Private facts never widen.** A `Private (user-only)` fact is scoped to that person's
  mapped Google identity, and if the operator's user mapping has no destination for its
  subject it is **refused** with a `lost` note. Scoping it to the agent instead would
  publish one employee's inferred details to everyone who can use that agent — the ACL
  failure again, but leaking statements about people rather than documents.
- **TTL does not survive.** Memory Bank has no per-memory expiry, so a fact Copilot would
  have forgotten becomes permanent. Every TTL-bearing fact carries a note naming the date
  it would have expired.
- **An inference is not a statement.** `memorykind: inference|observation` means the model
  concluded it; the note says so, because it moves across as an asserted fact.

**What is deliberately NOT migrated.** `agentmemory` (session scratch, TTL-bounded — there
is nothing to preserve) and unattributed `intelligentmemory` rows, which get an explicit
environment-level note on every agent in the run rather than being silently left behind or
silently attached to an agent that never learned them.

### 1.20 Sign-in exists, and a session id stops being a bearer token (2026-08-12)

§4.5 and §1.18 recorded the same hole from two ends: the login page signed anyone in, and
every migration-scoped row carried `appUserId: 'default'`. The collections had always
filtered by `appUserId` — the filter was real, the value was the same for everyone, so the
isolation was decorative.

**What now exists.** `POST /api/login` verifies against the `appUsers` bcrypt hashes that
were written months ago and never called, and mints an opaque 32-byte token stored
server-side in `appLoginSessions` (TTL 7 days). The cookie carries only the token, so the
browser never learns an `appUserId` and therefore cannot assert one. No JWT: a revocable
row is what lets sign-out actually end a session.

```
Set-Cookie: csge_auth=…; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax
```

**Proven, by probe, in this order:**

```
1. migration route with NO cookie      -> 401 {"error":"not_signed_in"}
2. login with WRONG password           -> 401 {"error":"invalid_credentials"}
3. login with the seeded password      -> 200 {"email":"admin@cloudfuze.com",…}
4. cookie set?                            csge_auth cookies: 1
5. same migration route WITH cookie    -> 200 {"environments":[…]}
6. /api/me                             -> 200 {"email":"admin@cloudfuze.com","role":"admin"}
7. health still open                   -> 200
8. logout, then the route again        -> logout 200, then 401 {"error":"not_signed_in"}
```

Grade **P**.

**The isolation itself — the part that mattered.** `requireAuth` only proves you are *a*
user. A migration session id is passed by the client on every route, so without a second
check it remains the credential: anyone holding one reads that customer's environments,
staged agents and connector configuration. `enforceSessionOwnership` is mounted on the
scoped routers (not inside `getSession`, so a route added later inherits it rather than
having to remember it). Against a throwaway session owned by another user:

```
admin asks for another customer's session:  -> 403 {"error":"session_not_yours"}
admin asks for a session it does own:       -> 200 {"environments":[…]}
```

Grade **P**. In the browser: a wrong password now stays on the login screen with "Invalid
email or password" (it previously proceeded), and the correct password lands in the app.

**What is deliberately still open, and why.**

- `/api/health` and `/api/auth/*` are unauthenticated. The OAuth callbacks arrive as
  redirects from Microsoft and Google; a 401 there breaks the connect handshake rather
  than protecting anything, and they carry their own one-time `state`.
- Sessions created before today still carry `'default'` and are reachable by any signed-in
  user. Locking them out would strand every already-connected customer behind a migration
  they cannot run. This is a KNOWN residual hole with a stated closing move, and it is
  counted out loud on every boot:

  ```
  WARN: 2 migration session(s) still owned by the placeholder 'default' user — any
        signed-in user can reach them. Run `npx tsx src/scripts/rekeyAppUser.ts`…
  ```

**The re-key, dry-run only so far.** `src/scripts/rekeyAppUser.ts` resolves the target from
`appUsers` by email (an id typed by hand that matches no account would attribute every row
to someone who cannot sign in) and defaults to printing what it would do:

```
DRY RUN — 'default' → admin@cloudfuze.com (6a7168dfc40369e8807f5cc3)
  migrationSessions      2      migrationRuns         34     migrationResults      96
  migrationLogs        706      agentIRCache          60     environmentsCache      1
  stagedAgents         102      connectorCredentials  10     adkDeployments         5
  knowledgeConnectors    1      identityMap/connectorOpIndex/authSessions 0
would move 1017 row(s). Nothing was changed.
```

Grade **P** for the dry run; **U** for the commit path — it has not been executed, and it
will not be until an operator names the owner. It is not run on boot on purpose: a silent
re-key at startup attributes whatever is in the database to whoever deploys next, which is
the exact cross-tenant mistake this work exists to prevent. Secret Manager ids are NOT
rewritten — `connectorCredentials` rows keep the ids they were stored under and deployed
agents read those exact ids, so re-keying changes who can see the record, not where the
secret lives.

**Seeded accounts.** `admin@cloudfuze.com / CloudFuze@2026` and `demo@cloudfuze.com /
Demo@2026` were literals in `db/mongo.ts`, created on first boot. A published default
credential on this tool is a compromise of the CUSTOMERS, not of us: it holds two clouds'
admin tokens. Seeding now reads `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` /
`SEED_DEMO_*`; outside production the old values remain as a development fallback and the
account is flagged `seededWithDevDefault` with a startup warning; in production nothing is
seeded without the env values and the log says why. The old password stays in git history
either way — any deployment still using it must change it.

### 1.21 The first LIVE migration attempt, and a billable leak it uncovered (2026-08-12)

§1.18 proved the dry run through the UI. Running it LIVE found three things, one of which
was my own test harness and is the least interesting of the three.

**a) The ACL gate works on a live run.** First proof — until now it had only been reasoned
about and skipped (dry runs bypass it by design).

```
[warn] ── Migration stopped: 1 agent(s) would lose source permissions ──
[warn]   "Confluence_agent" has 2 knowledge source(s) from Confluence whose permissions
         cannot be carried into Gemini…
[warn]     • Engineering, Chaitanya Malle, Demo Company Wiki (Confluence, via confluence-crawler)
[warn]     • testing confulence without page names in name section (Confluence, via confluence-crawler)
AGENT Confluence_agent: created=False deployed=False error=acl_acknowledgement_required
DONE: Stopped · 1 agent(s) need a permission-loss acknowledgement before migrating
```

Nothing was created. Grade **P**.

**b) My harness sent the wrong destination shape, and the product spent money on it.**
I hand-built the plan body with `{project, app}`; the UI sends `{project, engine,
assistant}`. So `engine` was `undefined`:

```
ADK failed (register: 404: Engine "undefined" does not exist.)
 (WARNING: the deployed Reasoning Engine could not be deleted and is still billable)
```

The 404 is my mistake. What is NOT my mistake is that the pipeline deployed a Reasoning
Engine BEFORE anything validated the destination, and then could not clean it up. Recorded
as **X** against "a bad destination fails cheaply".

**c) The cleanup path could never have worked, and 81 engines prove it.** Counting engines
against `adkDeployments`:

```
86 engines, 81 with no owning record
  Agent1 × 15 · Migration Knowledge Advisor × 5 · Knowledge Assistant × 5 · …
```

`deleteReasoningEngine()` minted its own credentials with `new GoogleAuth(...)` —
Application Default Credentials — while every other call in `adkDeployer.ts` uses the
service account. On a host where ADC is absent or stale it fails, and the failure was
swallowed into `return false`. Reproduced directly: a spike using the same ADC path
returned

```
invalid_grant: reauth related error (invalid_rapt)
```

So every registration failure since the beginning has leaked an always-on billable engine,
and the log line ("could not be deleted") read like bad luck rather than a systematic
break. Fixed by passing the caller's `saToken` and logging the API's actual refusal instead
of a bare boolean. Grade **P** for the diagnosis; **U** for the fix, which has not yet had
a registration failure to clean up.

**d) "Orphan" needed a better definition than ours.** My first count called
`7686282818770436096` an orphan — the live Confluence_agent that answers Confluence
questions. `adkDeployments` holds 5 rows for 86 engines because agents repointed by hand
during repair work were never recorded. The authority on what is live is the GALLERY, not
our database. `scripts/reapOrphanEngines.ts` checks both and aborts rather than guessing if
it cannot read either:

```
86 engine(s) — serving a gallery agent: 16 — recorded in adkDeployments: 5
  KEEP 7686282818770436096  Confluence_agent   SERVING a gallery agent
  …
62 unreferenced engine(s); 25 kept.   Report only — nothing was deleted.
```

Report-only by default and `--older-than` guarded. Grade **P** for the report; the delete
path is **U** and stays that way until an operator authorizes it.

**e) Confluence indexing is not deterministic.** Same agent, same 6 spaces, two runs 10
minutes apart:

```
07:45:24 [warn]  Confluence crawl failed: Import completed but 0 pages were indexed.
07:54:01 [ok]    Confluence: 7 page(s) ready — data store queued for grounding.
```

Pages were fetched and uploaded to GCS in both runs; Discovery Engine reported 0 indexed
in the first within a 6m41s wait. That matches the indexing lag the code already documents
(and the `pendingGroundingRechecks` sweep exists for), but it means a live migration can
report a knowledge source as failed when it would have succeeded minutes later. Recorded as
**open**, not fixed.

### 1.22 A live migration that actually completed (2026-08-12)

The first end-to-end LIVE migration to finish, after §1.21's two false starts (one my
harness, one my own edit restarting the dev server mid-deploy).

```
08:27:13  live run started
08:29:09  Confluence: 7 page(s) ready — data store queued for grounding.
08:29:09  Confluence_agent: source changed since last migration
          (configured connectors changed, instructions changed) — redeploying via ADK.
08:32:21  adk: updated existing agent in place (no creation quota used)
08:32:21  Confluence_agent: deployed via ADK (ENABLED).
08:32:35  Confluence_agent → gemini-enterprise-…/17674689114292745852
          · deployed=true shared=true verified=true

RUN done: 1/1 created · 1 deployed · 1 shared · 1 verified      (5m22s)
```

Verification asked the deployed agent a real question and it answered from the migrated
knowledge:

```
verifySample: I can access documents such as the "Architecture Overview" and the
              "Deployment Guide" for the CloudFuze migration platform.
```

Grade **P** for: the live path completes; idempotency updates in place rather than
duplicating (`no creation quota used`); the Confluence crawl grounds the agent per-agent
via VertexAiSearchTool; sharing and verification run.

**The ACL gate on a live run — proven separately, same agent.** Without the
acknowledgement the run stops between the phases, creates nothing, and names both sources.
With it, the run proceeds and both sources carry an `acl:` note into the report. Grade **P**.

**Confluence indexing settled.** §1.21e recorded a run that indexed 0 pages. Two subsequent
runs both produced 7. Same agent, same spaces, same credentials — so the 0 was Discovery
Engine indexing lag inside the wait window, not a broken crawl. It remains true that a live
migration can report a knowledge source as failed when it would have succeeded minutes
later; the `pendingGroundingRechecks` sweep exists for exactly that and was not needed here.

**A contradiction inside a successful run.** The same run said both:

```
[ok]   Confluence: 7 page(s) ready — data store queued for grounding.
[warn] 2 knowledge source(s) NOT migrated (needs a connector or manual step):
       Engineering, Chaitanya Malle, Demo Company Wiki→confluence-crawler, …
```

The report was right — `[mapped] knowledge:Confluence: 7 Confluence page(s) from 2
space(s) grounded via ADK VertexAiSearchTool` — and the agent demonstrably answers from
those pages. The WARN was the liar: the `other` list excluded Dataverse-snapshot and
SharePoint-connector sources but never the Confluence ones the crawler had just handled.

That is worse than a cosmetic log bug. It is a customer-facing claim that knowledge was
left behind on a run where it was not — an overclaim in reverse — and a warning that
contradicts the report trains people to ignore the warnings that are real. Fixed by
excluding crawled Confluence sources from the list.

**Destination validation, closing §1.21b.** The exact body that previously cost a built,
billable Reasoning Engine to reject now fails at plan time, before extraction:

```
POST /api/migrate/plan  {"project":"…","app":"cf-knowledge-search"}   ← no `engine`
  -> 400 {"error":"invalid_destination","detail":"The destination for
      https://orga243378d.crm.dynamics.com is missing its project or Gemini app.
      Pick both on the Select & Map Environments step before migrating."}

POST /api/migrate/plan  {"project":"…","engine":"…","assistant":"default_assistant"}
  -> 200 {"totalAgents":1,…}
```

Guarded in two places on purpose: the route (cheapest) and `targetFor()` in the
orchestrator, because a plan can reach the orchestrator from a resumed session and
"validated at the edge" is not "cannot happen". Grade **P**.

**Runs stranded at `running`.** A run only leaves `running` because `finishRun` says so,
and that call is in-process — so any crash, deploy or `tsx watch` restart strands the row
forever. Measured: 5 such rows, the newest caused by me editing a server file while a
migration was deploying. `reconcileInterruptedRuns()` now closes them on boot as
`interrupted` (not `failed` — we do not know how far they got, and the staged rows survive
for a resume). Proven: 5 → 0 on the next restart. Grade **P**.

**Still open from this run.** Web browsing is dropped whenever an agent also has knowledge
("ADK can't combine VertexAiSearchTool grounding with googleSearch"), reported as `lost`.
Sharing lands at ALL_USERS because ADK registration does that by default and the source was
narrower — reported as `needs-review`, with 1 principal auto-granted. Both are honest
notes, neither is fixed.

---

### 1.23 The topic-embedded connector-id bug — 45 → 71 Dataverse operations (2026-08-12)

The target set is Confluence / Jira / HubSpot / Dataverse. Measured before the fix
(`_diag_target_four.ts`), five of the ten Dataverse agents bound **zero** operations:

```
  D365 Sales - Configuration Agent          [Dataverse]  0/9 ops bind
  Quality Evaluation Agent                  [Dataverse]  0/8 ops bind
  Quality Evaluation Agent - Incident       [Dataverse]  0/5 ops bind
  QualityEvaluationAgentForConversation     [Dataverse]  0/4 ops bind
  Sales Qualification Agent Config Assista  [Dataverse]  0/3 ops bind
  Dataverse    10 agent(s)   45/79 operations bind
```

`_dump_conn_refs.ts` found the cause — the reference on a topic-embedded
`InvokeConnectorAction` is not the shape the TaskDialog parser was written for:

```
op:        PerformUnboundActionWithOrganization
  raw ref: QMA.Incident.DVPluginConnection
  parsed:  incident
```

`QMA.Incident.DVPluginConnection` is a solution-prefixed connection reference NAME, so the
middle segment is the Dataverse ENTITY, not a connector id. `incident` matches no registry
entry, `resolveOpIndex` returned null, and the tool was skipped by a `continue` whose
comment says the loss is "reported elsewhere" — it was not. Silently absent, with no
FidelityNote: the worst failure mode this project has, because the report says nothing.

Fix: `resolveConnectorId(ref, operationId)` ranks the evidence — an explicit `shared_*` in
the reference (`exact`) beats the operation family (`inferred`) beats the middle segment
(`named-only`). The `…WithOrganization` operation family is Dataverse and nothing else.
17 unit tests, including that the entity name must never win.

Measured after, same command, same tenant:

```
  D365 Sales - Configuration Agent          [Dataverse]  9/9 ops bind
  Quality Evaluation Agent                  [Dataverse]  7/8 ops bind · 1 refused
  Quality Evaluation Agent - Incident       [Dataverse]  4/5 ops bind · 1 refused
  QualityEvaluationAgentForConversation     [Dataverse]  4/4 ops bind
  Sales Qualification Agent Config Assista  [Dataverse]  2/3 ops bind · 1 refused
  Dataverse    10 agent(s)   71/79 operations bind
  Confluence    4 agent(s)   1/1 operations bind
  HubSpot       2 agent(s)   3/3 operations bind
```

Tenant-wide bound operations 53 → 78. Grade **P** for the binding count (real extraction,
real binder). Grade **U** for whether these tools return live data — no bound Dataverse
call has been executed against the API yet; that needs the application-user grant.

**The 8 that remain are refused, not lost silently.** Every one is a required *path*
parameter the source agent computes from Copilot state:

```
Case Management Agent — Act on a customer issue - PerformBoundActionWithOrganization:
  "entityName" is computed at run time … and is required for this call,
  so the tool would silently query the wrong data.
Quality Evaluation Agent - Incident — Fetch Payload and Evaluate - GetItemWithOrganization:
  "recordId" is computed at run time in Copilot …
```

Leaving `recordId` to the model means fetching a hallucinated record id — a wrong answer
presented as a right one. Refusing with a `lost` note is the correct call and I am not
weakening it without a decision. Non-required expression inputs (`item.msdyn_name`,
`item.BotConversationId`) already degrade to `needs-review` and still bind: 59 such notes.

**Jira: zero agents in this tenant.** Nothing to build, nothing to prove.

**CORRECTION — they are not silently absent.** I wrote here that 12 operations across
`shared_googledrive` and `shared_get` produce no bound call AND no note. Wrong, and wrong
in the direction that matters: I accused the product of the exact dishonesty it is built to
avoid, on the evidence of an instrument that reads ONE of three reporters.
`_diag_tool_coverage.ts` only runs `buildBoundToolSpecs`. The orchestrator has two more
passes — connectors with no `REGISTRY_BY_ID` entry (orchestrator.ts:1693) and per-operation
`readinessFor` blocks (orchestrator.ts:1716) — and both emit `lost` notes with reasons.

Measured on Migration Knowledge Advisor, the worst case in the tenant (18 tools, 1 binds):

```
  (1) fidelity notes from the BINDER: 0
  (2) connectors with NO registry entry:
      [lost] connector:shared_get — Operations wanted: GetDeals, GetContacts, GetCompanies
  (3) per-OPERATION readiness:
      [lost] shared_googledrive.ListRootFolder on Google Drive
          Google Drive's connector paths (/datasets/default/files/{id}) are a Power
          Platform abstraction, not Google Drive API paths…
      … 11 blocked operations
  >> 14 connector tool(s) produce no call; 12 note(s) across all three reporters.
```

14 unbound tools, 14 covered. Grade **P** for the reporting being complete.
`_diag_agent_detail.ts` now runs all three passes so this instrument cannot make the claim
again. The third time this session a count contradicted a proven fact and the count was the
thing that was wrong.

The capability gap is real and unchanged: Google Drive's 11 operations and `shared_get`'s 3
still do not migrate. Only the accusation of silence was false.

---

### 1.24 MCP servers and connected agents — what survives, and what cannot (2026-08-13)

Two tool kinds were extracted, counted, and then migrated by nobody. `_diag_mcp_and_agents.ts`
over all four environments:

```
[mcp-server] AA → Jira - Jira MCP Server
    mcp: {"operationId":"mcp_JiraIssueManagement","toolSelection":"specific",
          "tools":["GetCurrentUser","ListIssues","ListIssues_Datacenter",
                   "ListProjects","ListResources","ListIssueTypes_V2"]}
[connected-agent] AA →  [Internal]TransciptParserAgent
[connected-agent] AA → Knowledge Assistant
[mcp-server] Case Enrichment Onboarding Agent → Microsoft Dataverse MCP Serv
    mcp: {"operationId":"InvokeMCP","toolSelection":"unknown"}   (x4)
[mcp-server] Service Operations Agent → D365 Contact Center Admin MCP
    mcp: {"operationId":"msdyn_D365ContactCenterAdminMCPServer","toolSelection":"unknown"}

mcp-server:      6 tool(s), 0 with a URL in the extracted binding
connected-agent: 2 tool(s)
    " [Internal]TransciptParserAgent" → resolves to agent " [Internal]TransciptParserAgent"
    "Knowledge Assistant" → resolves to agent "Knowledge Assistant"
```

**Zero of six carry a server URL.** MCP in Copilot is tunnelled through the Power Platform
proxy, so the transport cannot be migrated — that is a fact about the payload, not a gap in
our deployer. What CAN be migrated is the capability, because where `toolSelection` is
`specific` the declared tool names turn out to be ordinary operations on the same connector:

```
shared_jira index: 65 operations
  GetCurrentUser  PRESENT   ListIssues     PRESENT   ListIssues_Datacenter  PRESENT
  ListProjects    PRESENT   ListResources  PRESENT   ListIssueTypes_V2      PRESENT
```

So `buildBoundToolSpecs` now expands an MCP server into one bound operation per declared
tool. `_diag_agent_detail.ts "AA"`, after (**P**):

```
  bound calls for shared_jira:
    GET   https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/myself
       description: Get current user
    GET   https://api.atlassian.com/ex/jira/{cloudId}/rest/api/2/search
       description: Get list of issues
    GET   https://api.atlassian.com/ex/jira/{cloudId}/rest/api/datacenter/search
       description: Get list of issues (Datacenter)
    GET   https://api.atlassian.com/ex/jira/{cloudId}/rest/api/project
       description: Get projects
    GET   https://api.atlassian.com/ex/jira/{cloudId}/rest/api/oauth/token/accessible-resources
       description: Get list of Resources
    GET   https://api.atlassian.com/ex/jira/{cloudId}/rest/api/v2/types/issue/createmeta
       description: Get issue types (V2)
```

Six real Atlassian URLs from a tool that produced none. The first attempt gave all six the
description `Jira MCP Server` — the MCP tool's own text names the SERVER, so copying it
onto every operation produced six tools a model cannot choose between. Dropping it and
letting the connector's per-operation description answer is what produced the output above.

**What is NOT rebuilt, and is now said so by name.** Five of the six MCP tools declare no
list (`toolSelection: unknown`). Guessing which of a server's tools an agent used would be
inventing capability, so they are refused:

```
  [none] Microsoft Dataverse MCP Server   (tool (MCP server))
      MCP server with no server address and no declared tool list (unknown) — nothing to rebuild.
```

**Connected agents.** Both resolve to real agents by name. Gemini agents cannot call each
other, so this is `needs-review`, never `mapped` — but the report now distinguishes a target
that is in the same migration from one that is not, because "migrate the other agent" is
useless advice when it is three rows down in the same run.

**Where it shows.** Three surfaces were checked, not assumed:

- Connectors screen (`_diag_connector_screen.ts "AA"`, **P**) — the scan is a regex over raw
  component data, so it recorded `mcp_JiraIssueManagement`, a server name no connector can
  perform. It now names the declared tools:
  ```
    shared_jira  [shared_jira]
      used by:    AA
      operations: GetCurrentUser, ListIssueTypes_V2, ListIssues, ListIssues_Datacenter, ListProjects, ListResources
  ```
- Assessment / Explore (`_diag_assess_tools.ts "AA"`, **P**) — the pre-migration assessment
  listed instructions, topics, knowledge and capabilities and **not one tool**, so an agent
  whose whole job was calling Jira read as trivially migratable. Tools are now components
  with dependencies:
  ```
  [partial] Jira MCP Server   (tool (MCP server))
      Rebuilt as 6 direct shared_jira call(s) (GetCurrentUser, …) — needs that connector's
      credentials. MCP itself is not migrated, so the agent can only do what this list names.
  [manual] Knowledge Assistant   (tool (connected agent))
      Invokes another Copilot agent as a tool. Gemini agents cannot call each other …
  ```
- Migration report — the per-tool pass previously said every MCP server "was NOT migrated"
  unconditionally. It now grades on how many declared tools actually bound: `mapped`, or
  `partial` naming the ones that did not, or `lost`. **T** — typecheck + 102 unit tests; no
  live migration has been run since this change.

Honest limits: the migrated agent loses MCP's dynamic discovery (it can only do what the
source declared), and the two connected-agent relationships are reported, not rebuilt.

---

### 1.25 Tool census — every agent, every tool, how many produce a real call (2026-08-13)

"Can we find the tools on any agent, like the Hubspot one?" is only answerable by asking
every agent. `_diag_tool_census.ts` runs the extractor and the REAL builder
(`buildBoundToolSpecs`, against the customer's own connector definitions) over all four
environments:

```
22 agent(s) with tools · 10 fully callable
126 tool(s) found → 92 vendor call(s) built
by kind: connector=106  ai-builder=1  mcp-server=6  connected-agent=2  ai-plugin=8  flow=3

COULD NOT READ 2 environment(s) — agents there are absent from every number above:
  CF_MANAGE — Dataverse GET bots?...
  Microsoft 365 — Dataverse GET bots?...
```

Finding is now total: **126 of 126 tools are extracted and named**, across six kinds. The
Hubspot case is closed on both sides:

```
  OK   Hubspot agentt                                 4 tool(s) → 4 call(s)
  OK   HubSpot Agent                                  2 tool(s) → 2 call(s)
  OK   D365 Sales - Configuration Agent               9 tool(s) → 9 call(s)
  OK   confluence agent                               1 tool(s) → 1 call(s)
```

**Calling is not total, and the 34-tool gap is fully itemised** — every one names its kind
and connector, none is silent:

| Not callable | Count | Why |
|---|---|---|
| Google Drive operations | 11 | Connector paths (`/datasets/default/files/{id}`) are a Power Platform abstraction, not Drive API paths — needs a hand-written mapping |
| `ai-plugin` tools | 8 | Custom API plugins; no connector id in the payload at all |
| MCP servers, `toolSelection: unknown` | 5 | No tool list to rebuild (§1.24) — refused rather than guessed |
| Power Automate flows | 3 | Only the flow id is in the payload; flows are a later phase |
| Dataverse ops with a Power Fx required arg | 3 | e.g. `recordId` = `=Topic.EvaluationRequest.evaluationRecordId` — refused, because omitting a required filter returns the WRONG rows rather than an error |
| Connected agents | 2 | Gemini agents cannot call each other (§1.24) |
| `shared_sharepointonline.HttpRequest` | 1 | Arbitrary-URL passthrough, no fixed vendor path |
| `ai-builder` custom prompt | 1 | Prompt folded into the instruction; the model is not migrated |

The gap is 27% of tools and it is concentrated: Google Drive alone is a third of it. Note
the census counts an MCP server as ONE tool but it yields six calls, which is why an
"OK/GAP" verdict uses `calls >= tools`, not equality.

**Still unread: 2 of 4 environments.** Every number above excludes them, and no claim about
"any agent" covers agents we have never been allowed to list.

---

### 1.26 "What can we migrate without errors?" — graded per agent (2026-08-13)

The question has two meanings and they give very different answers, so
`_diag_readiness.ts` refuses to collapse them:

- **RUN-CLEAN** — the run finishes without throwing. Nearly everything is run-clean,
  because losses are reported as fidelity notes rather than raised. This sense of "no
  errors" is the one that misleads.
- **FAITHFUL** — every component of the source agent has a migrated equivalent:
  instructions, every topic, every knowledge source, and every tool producing a real vendor
  call. Nothing `lost`, nothing `manual`.

Graded live over the two readable environments:

```
66 agent(s) graded · 32 faithful · 34 partial · 0 thin
FAITHFUL = every component has a migrated equivalent. It does NOT mean a live run has been proven.

NOT GRADED — 2 environment(s) could not be listed:
  CF_MANAGE · Microsoft 365
```

**The load-bearing detail: only 3 of the 32 faithful agents have any tools at all.**

```
Confluence_agent                            912ch instr · 13 topic · 1 tool · 2 knowledge
Enterprise Agent                            833ch instr · 13 topic · 1 tool · 4 knowledge
Shadow Agent & License Governance Auditor  2495ch instr · 13 topic · 2 tool · 0 knowledge
```

The other 29 are instruction + topic + knowledge agents, and they are not empty — sizes
were printed precisely so "nothing was lost" could not hide an agent with nothing in it
(`Copilot in Dynamics 365 Sales`: 5361ch instructions, 93 topics; the smallest,
`D365 Sales Agent - Company Resolver`: 36ch, 2 topics).

So the honest headline is: **agents whose behaviour is instructions, topics and knowledge
migrate whole; agents whose behaviour is API calls mostly do not, yet.** The 34 partial
agents each name their own reason (§1.25's table aggregates them); the most common single
cause is Google Drive's 11 operations.

`FAITHFUL` is a claim about MAPPING — every part has a target. It is NOT a runtime claim.
The only runtime evidence in this ledger is §1.16 (one migrated agent reached
`api.hubapi.com` and got a vendor-side auth error, which proves reachability, not success).
Grade for "these 32 will work in production": **U**.

---

### 1.27 Correction — SharePoint is further along than 1.26 implied (2026-08-13)

§1.26 graded SharePoint "not ready" on two signals: one unbindable tool
(`shared_sharepointonline.HttpRequest`) and a planner that says sources are "reconnected
via Gemini's native connector". Both are real, and the verdict drawn from them was wrong.

`orchestrator.ts:185-225` tries **copy mode FIRST** — resolve the share URL through
Microsoft Graph, download the item, upload it to a document data store — and only falls
through to the native connector when the URL is genuinely ambiguous. That path was proven
live on 2026-08-07 (commit `755915c`: "1/1 created, deployed, shared, verified, with
topics deployed as sub-agents and SharePoint wired via VertexAiSearchTool"), and it exists
precisely because Google's connector authenticates against SharePoint REST, which accepts
app-only tokens only when minted with a certificate.

So the honest question is not "does SharePoint work" but "how many sources resolve to a
single file". `_diag_sp_paths.ts` runs the migration's own resolver over every SharePoint
source in the tenant:

```
  COPY MODE Agent1 :: 2026 Agentic Coding Trends Report.pdf     kind=file
  COPY MODE Enterprise Agent :: daily_queries.txt               kind=file
  COPY MODE C2MessageGeneratorAgent :: daily_queries.txt        kind=file
  COPY MODE HR Policy Assistant :: WFH Policy- Neutara…pdf      kind=file
  COPY MODE HR Policy Assistant :: Neutara HR Leave…pdf         kind=file
  COPY MODE IT Help Desk Agent :: Rollbar.docx                  kind=file
  COPY MODE IT Help Desk Agent :: BAMBOO HR.docx                kind=file
  FALLBACK  Knowledge Assistant :: TestingPermissions   — no URL captured on the source
  FALLBACK  Knowledge Assistant :: daily_queries.txt    — no URL captured on the source
  FALLBACK  CloudFuze Studio Migrate :: TestingPermissions  kind=folder-multiple-files (3)
  FALLBACK  HR AGENT :: Documents                           kind=not-found

7 source(s) take the proven copy-mode path · 4 fall back to the native connector
```

**7 of 11 take the proven path.** The 4 that do not split into three distinct causes, none
of which is "SharePoint is broken":

| Fallback cause | Count | What it actually is |
|---|---|---|
| No URL captured on the source | 2 | an EXTRACTION gap — the source names a site but we stored no address to resolve |
| `folder-multiple-files` | 1 | a folder with 3 files; the resolver refuses to guess which one the author meant |
| `not-found` | 1 | the named item ("Documents") did not resolve through Graph at all |

Two things in §1.26 stand and should not be softened by this correction:

1. The customer-facing plan still says "Reconnected via Gemini's native connector —
   requires identity-federation setup" for sources that will actually take copy mode. The
   run does the better thing and the screen describes the worse one. Wrong either way.
2. `migrationResults` holds `partial` and `lost` rows for `CloudFuze Studio Migrate`'s
   SharePoint site — which is exactly the `folder-multiple-files` source above, i.e. the
   fallback failing, not copy mode failing.

Grade: copy mode **P** (live 2026-08-07, and 7 sources resolve to a single file today);
native-connector fallback **X** for content (three pre-existing connectors in the test
project hold 0 documents).

---

### 1.28 Fixing the four SharePoint failures (2026-08-13)

§1.27 found 4 of 11 SharePoint sources falling back to the connector that returns no
content. Each cause was diagnosed before anything was changed.

**Cause 1 — the source stored no address (2 sources).** Copilot writes SharePoint knowledge
in two shapes; `FederatedStructuredSearchSource` keeps only an opaque id:

```
 "raw": { "source": { "kind": "FederatedStructuredSearchSource",
                      "skillConfiguration": "daily_queriestxt_ZEHQ13QHyGoE_iNOUiCtg" } }
```

`_probe_skillconfig.ts` established the id resolves to nothing — searching Dataverse for it
returns only the component that already contains it. But the SAME source attached to other
agents kept the address:

```
  daily_queries.txt  msdyn_c2messagegeneratoragent…  -> https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt
  daily_queries.txt  cr88d_KBGroundingTestAgent…     -> https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt
  daily_queries.txt  cr88d_CSGEKnowledgeTestAgent…   -> (skillConfiguration only)
```

`services/sharePointUrlRecovery.ts` recovers it, requiring an exact name match AND unanimity
across every matching row — two rows disagreeing is returned as `ambiguous`, not resolved by
picking one, because grounding an agent on the wrong file is worse than not grounding it. It
is still a name match, so every recovery emits a `needs-review` note naming the component the
address came from. Live (`_probe_url_recovery.ts`), **P**:

```
  NOT-FOUND  Knowledge Assistant :: TestingPermissions
  RECOVERED  Knowledge Assistant :: daily_queries.txt
             https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt
             from msdyn_c2messagegeneratoragent.topic.daily_queriestxt_Sub5wzEcEfZNleCgziYLd

1 address(es) recovered · 1 left for a human
```

7 unit tests, including the refusals: two addresses under one name, a Confluence URL in the
payload, a name too short to identify anything, and a 403 degrading rather than throwing.

**Cause 2 — a folder of several files (1 source).** This was treated as an ambiguity and
punted to the native connector, so a 3-file folder migrated as nothing — which is exactly
the `lost` row already sitting in `migrationResults` for `CloudFuze Studio Migrate`. But the
author pointed the agent at that folder, so every file in it is in scope: copy mode now
copies each one (bounded at 25, truncation reported, never silent). **T** — typechecks and
the path is exercised only when a folder source runs.

**Cause 3 — `not-found` (1 source).** "Documents" resolves to nothing through Graph and is
too generic to recover by name. Correctly refused; left for a human.

**Two honesty fixes shipped alongside**, both cases of the screen describing a worse path
than the one that runs, or a narrower capability than the label implied:

- The plan said *"Reconnected via Gemini's native connector — requires identity-federation
  setup"* for sources that actually take copy mode. It now states what happens: fetched
  through Graph with the customer's app credentials, point-in-time, **and that SharePoint
  permissions are not carried over**.
- `shared_sharepointonline.HttpRequest` reported as `mapped`. The source tool could call any
  SharePoint REST endpoint; the migrated agent gets folder-scoped list/read instead, because
  our credential carries `Sites.Read.All` and there is no per-site application permission —
  reproducing it would widen access to every site in the tenant. Now `partial`, saying so.

Grade for the whole change: **T** — `tsc --noEmit` clean in server and web, 109 unit tests
pass, and the recovery function is proven against live Dataverse. No migration has been run
since; the folder-copy path and the two new notes have not appeared in a real report yet.

---

### 1.29 SharePoint: files are stored, everything else is tool-called (2026-08-13)

The rule the product now follows, stated once so the code can be checked against it:

| The author attached | What the migrated agent gets |
|---|---|
| ONE FILE (`daily_queries.txt`, `Q1.pdf`) | fetched through Graph and indexed — semantically searchable, point-in-time |
| a folder, library or site | LIVE tools: `sharepoint_list_files` + `sharepoint_read_file`, scoped to that path |
| a SharePoint API tool (`HttpRequest`) | the same live tools, folder-scoped (§1.28) |

Three changes make the code match it.

**1. Broad sources are no longer bulk-copied.** §1.28 had folder sources copying every file
inside; that has been reverted. A copy of a folder goes stale, strips SharePoint's
permissions from every file it duplicates, and can be far larger than what was attached.
The whole-site crawl (`migrateSharePointToDataStore`) now runs ONLY when the live tools
cannot — i.e. no app credentials — and never over a source copy mode already fetched (that
would index the same file into a second data store).

**2. Every named source scopes the tools, not just the first.** `scopeUri` came from
`spGraphSources[0]`, so an agent with "HR Policies" and "IT Runbooks" attached could reach
only one while the report claimed SharePoint was migrated. `adk_deploy.py` now takes
`scopeUris[]`: `sharepoint_list_files` lists across all of them (tagging each item with its
`source`, and reporting per-source errors instead of hiding them), and
`sharepoint_read_file` tries each in turn. Every attempt still goes through `_scoped_path`,
so a path that escapes one folder is rejected rather than retried against a wider one. The
union of the author's own paths is the source agent's reach; a common parent would be wider.

**3. A copied file is not also a tool scope.** Handing a FILE path to the folder tools
gives them a scope with no children — so sources covered by copy mode are excluded from
`scopeUris`, and broad sources (exactly what copy mode declines) are what the tools serve.

**Reading inside the data already worked** and is unchanged — `sharepoint_read_file`
extracts text from `.txt .md .csv .json .log .xml`, PDF (`pypdf`), Word (`python-docx`) and
Excel (`openpyxl`), capped at 20 MB in and 60 000 characters out, with `truncated` reported
rather than silently cut.

The new grounding note says what the tool path costs, since it is not the same guarantee an
indexed copy gives:

> Reachable live: the migrated agent lists and reads files under this path through Microsoft
> Graph … Content is current rather than a copy, and the tools cannot reach outside this
> path. Note the agent reads with the app identity, so it can see everything under the path
> regardless of who is asking.

Grade **T**: `tsc --noEmit` clean in server and web, 109 unit tests pass, `adk_deploy.py`
parses. No migration has run since, so multi-scope listing and the tool-served path have not
been exercised against live SharePoint — that is the next thing to run, on `HR AGENT`
(folder source) and `CloudFuze Studio Migrate` (3-file folder).

---

### 1.30 Does the SharePoint fix hold for ANY agent? Census, and two gaps it exposed (2026-08-13)

The fix was written against two agents, so it was replayed over every SharePoint source in
the tenant (`_diag_sp_outcome.ts` — recover the address if missing, resolve it through
Graph, apply the rule). First run, **P**:

```
   8  STORED
   1  NOTHING — no address
   1  TOOLS
   1  TOOLS (unresolved: not-found)
```

Two gaps only a census could show:

**Gap 1 — a recovered address never reached the TOOLS.** Recovery patched a clone handed to
copy mode; `spGraphSources` still filtered on the source's own `reference`. Copy mode
declines anything broader than one file, so a recovered FOLDER address was recovered and
then dropped — no copy AND no tool scope, the same silent nothing the recovery existed to
fix. Now every consumer reads the address through one `spAddressOf()` helper.

**Gap 2 — recovery searched only the agent's own environment.** SharePoint is TENANT-wide;
Dataverse environments are not. "TestingPermissions" is address-less in CloudFuze Agent
Migration Hub and fully addressed in filefuze, so the one environment that could answer was
the one never asked. `recoverSharePointUrlAcrossEnvs()` searches every readable environment,
own first, and applies the unanimity rule across the WHOLE search — two environments
disagreeing is the ambiguity this must refuse, not a tie to break by preferring the nearer.

After both, same command, same tenant:

```
  Knowledge Assistant
      TOOLS       TestingPermissions (address recovered)  [folder-multiple-files]
      STORED      daily_queries.txt (address recovered)  [file]
  …
   8  STORED
   2  TOOLS
   1  TOOLS (unresolved: not-found)
```

**11 of 11 sources now get something; `NOTHING` is gone.** The remaining `not-found`
("Documents" on HR AGENT) still gets a tool scope — `resolveShareUrlSmart` could not resolve
it as a share link, which does not prove the tools' own `/sites/{host}:{path}` resolution
will fail. It is labelled `TOOLS?` rather than counted as a success.

Honest limits on "any agent": this holds for any agent in the two environments we can READ.
CF_MANAGE and Microsoft 365 remain unlistable, so no claim here covers their agents. And
the whole census measures the DECISION, not the outcome — no migration has run since, so
`STORED`/`TOOLS` are what the pipeline will now choose, graded **T**, not what a live agent
has answered from.

---

### 1.31 Re-migrating an already-migrated agent: no duplicate, but a billable orphan (2026-08-13)

Run 1 — `Hubspot agentt`, migrated 2026-08-12, re-run through `resolveScope` + `runMigration`:

```
  Hubspot agentt
    created  : true  deployed=true  agentId=16165865784107067164
    shared   : true   verified: -
    ERROR    : terminated
```

`agentId` is **identical** to the pre-existing record, so no second gallery agent was
created. Idempotency keys on `(appUserId, envUrl, sourceId, project, engine)` from
`adkDeployments` — NOT on the display name — with a documented fallback for the same project
spelled as its ID or its NUMBER (that mismatch duplicated `Confluence_agent` on 2026-08-07).

**What it did NOT do is free.** The record's `reasoningEngine` changed
`4031470983670923264` → `6098904687610691584`: redeploy repoints the same agent at a fresh
engine, because ADK has no in-place update. Both engines are alive (**P**):

```
  4031470983670923264  HTTP 200  ALIVE — "Hubspot agentt" created 2026-08-12T14:38:40Z
  6098904687610691584  HTTP 200  ALIVE — "Hubspot agentt" created 2026-08-13T03:26:43Z
```

`deleteReasoningEngine()` is only called when REGISTRATION FAILS, so a successful redeploy
leaves the previous engine running and billed with nothing pointing at it. This is the
mechanism behind the already-recorded observation that 81 of 86 engines in the project have
no owning record. **Not fixed** — a re-migration is safe for duplicates and expensive for
engines.

Run 2 — `HubSpot Agent`, never migrated: created cleanly, `agentId=17963944182553943980`,
engine `894432368230662144`, 2 HubSpot connectors wired as live tools.

**Both runs ended `verified: -` with `TypeError: terminated: read ECONNRESET`.** The verify
step is a network call that reset twice identically; `created/deployed/shared` are all true.
A direct `:streamQuery` probe returned `404` — but it returned 404 against YESTERDAY's
working engine too, so the probe is unsound and proves nothing about either agent. Agent
health after this run is **U**: not shown working, and not shown broken.

**Operational note that nearly invalidated the test:** Docker was not running, so Mongo was
down and the server booted "without persistence". With no `adkDeployments` collection there
is no record to match, and a re-migration WOULD have created a duplicate. Mongo being up is
part of the idempotency guarantee, not incidental to it.

---

### 1.32 Deleting a migrated agent in Gemini used to produce a false success (2026-08-13)

Asked what happens when a customer deletes a migrated agent in the Gemini console and
re-runs the migration with a new token. Two answers, one of them a defect.

**The new token is fine, and needs no redeploy.** Connector credentials are read at CALL
time, not baked into the deployment: `scripts/adk_deploy.py:105` and
`services/connectorToolBuilder.ts:26` both resolve
`projects/{project}/secrets/{id}/versions/latest:access`. Saving a new token adds a version
to the same secret, so the already-deployed agent picks it up on its next call. Nothing
about Secret Manager blocks this — a rotated token takes effect without re-migrating.

**Deleting the agent did NOT trigger a redeploy.** The skip path required no source drift
and healthy knowledge stores:

```ts
if (!drift.changed && !unhealthyFiles.length && !unhealthySharePoint.length && !plan.forceRedeploy)
  return { created: true, agentId: existing.agentId, alreadyExists: true };
```

Deleting the agent in the console changes nothing on the SOURCE and breaks no data store, so
all three checks pass and the run reports `created: true` with the id of an agent that no
longer exists. Every other kind of destination damage was covered — a deleted knowledge data
store (found live 2026-08-06), a dropped SharePoint store — but not the agent itself. And
`forceRedeploy` exists only in the API: `grep -rn "forceRedeploy" web/src` returns nothing,
so the UI has no way to ask for one.

Fixed by checking existence on the skip path only (one GET, no cost on a real deploy): a
missing agent now recreates, logs it, and records a `needs-review` note saying the id has
changed so bookmarks pointing at the old one get updated.

Grade **T** — typecheck clean in server and web, 109 unit tests pass. Not yet exercised
against a genuinely deleted agent; the next UI run is that test.

---

### 1.33 Two defects the first UI run exposed (2026-08-13)

**Defect A — a deleted agent still reported "already exists".** §1.32's existence check was
in the wrong place. Live run at 04:21, both agents deleted in the console beforehand:

```
[04:21:14] adkDeployments: matched an existing deployment by engine - the project was
           recorded under a different spelling   sourceId=c58e5385-...
[04:21:15] Hubspot agentt: already exists  skipped
[04:21:15] HubSpot Agent: already exists  skipped
```

The API disagreed at that very moment (**P**):

```
  agent 16165865784107067164: HTTP 404
  agent 17963944182553943980: HTTP 404
  33 agent(s) listed under this assistant  (neither id among them)
```

Two causes, one on top of the other:

1. `getMigratedSnapshot()` matched on `project`, with none of the ID-vs-NUMBER fallback that
   `getAdkDeployment()` carries. The log line above is that fallback firing for the
   deployment — while the snapshot lookup, one line later, missed for exactly the reason the
   fallback exists. Snapshots exist for both agents (9 rows in `migratedAgentSnapshots`), so
   this was purely a spelling mismatch.
2. A missed snapshot took the "migrated before drift-tracking existed" early return, which
   sits ABOVE the existence check and returns `alreadyExists` unconditionally. **A check a
   return statement can jump over is not a check.**

Fixed by giving the snapshot repo the same engine-based fallback, and by hoisting the
existence check to the first thing inside `if (existing)` so no skip path can bypass it.

**Defect B — the connectors screen contradicted itself.** The custom HubSpot connector card
read *"We don't support this connector yet, so the new agent won't be able to use it"*
directly above *"All 4 operations map to Get CRM objects from Hubspot's own API"*, titled
with the raw id `shared_get-20crm-20objects-20from-20hubspot-...`. Both sentences came from
one filter: `callableConnectors` required a registry `def`, and a CUSTOM connector can never
have one — it was built in the customer's tenant. So it fell into the unsupported bucket
despite binding 4 operations, and there was nowhere to enter its token.

Callability is now decided by server-side readiness (`readiness.bindable.length`), not
registry membership, and the card shows the customer's own name for it.

Grade **T**: server + web typecheck clean, 109 unit tests, web build succeeds. Neither fix
has been through a UI run yet — the next one is the test.

---

### 1.34 The HubSpot token was fine — the validator was reading the wrong field (2026-08-13)

From the UI run:

```
[04:20:09] connector credentials stored but did not validate  connectorId: shared_hubspotsettingsv2  code: invalid_credentials
[04:20:11] connector credentials stored but did not validate  connectorId: shared_hubspotcrm         code: invalid_credentials
```

The registry declares the HubSpot group's field as `api_key`:

```ts
credentials: [{ key: 'api_key', label: 'Private App Token', type: 'password', placeholder: 'pat-na1-…' }]
```

`validateHubSpot()` read `v.api_token ?? v.access_token ?? v.private_app_token` — every
spelling except the one the customer was actually asked to fill. So it read an empty string,
returned `invalid_credentials — A HubSpot private app token is required` **without ever
calling HubSpot**, and blamed the customer for a value they had supplied correctly.

A validator that can fail before reaching the vendor is worse than no validator, because its
verdict is read as the vendor's.

**The runtime was never affected.** `authHeaderTemplate: 'Bearer {api_key}'` on both
connectors resolves the same field the customer filled, so deployed tools carried the real
token throughout — this was a false alarm on the save screen, not a broken migration.

Fixed by reading `api_key` first. Six new unit tests pin the class of bug rather than the
instance: they build the credential values from `CREDENTIAL_GROUPS` itself, so any group
whose field key drifts from its validator now fails in CI instead of in front of a customer.
They also assert the distinctions that matter — 401 is the vendor rejecting the token, 403
is a missing scope (`permission_denied`, since retyping a token never fixes a scope), and an
Atlassian 200 that identifies nobody is not a pass.

Grade **T**: 115 unit tests pass (6 new), server + web typecheck clean. The next save from
the UI is the live check.

---

### 1.35 First fully green UI run — deleted agents recreated, both verified (2026-08-13)

The run that tested §1.33 and §1.34 together, driven from the browser. Both agents had been
deleted in the Gemini console beforehand.

**The existence check fired, on both, before any skip could:**

```
[05:02:29] getAgent 17963944182553943980 failed (404)
[05:02:29] HubSpot Agent: the previously migrated agent (17963944182553943980) no longer
           exists in Gemini - deleted outside this tool. Recreating it.
[05:02:29] getAgent 16165865784107067164 failed (404)
[05:02:29] Hubspot agentt: the previously migrated agent (16165865784107067164) no longer
           exists in Gemini - deleted outside this tool. Recreating it.
```

Compare the same two agents one run earlier: `already exists  skipped`, twice, while the API
answered 404 for both ids. Same DB state, same destination — the difference is that the
check now sits where no return statement can jump over it.

**Both recreated, and both VERIFIED (P):**

```
[05:06:23] HubSpot Agent  -> …_1784788734248/5539949030633558392 - deployed=true shared=true verified=true
[05:06:48] Hubspot agentt -> …_1784788734248/9037777677775865129 - deployed=true shared=true verified=true
```

`verified=true` is new. Every prior run in this ledger ended `verified: -` with
`read ECONNRESET`; this one smoke-tested both agents through the deployed engine and got
answers. **`deployed=true` finally coincides with something that answered.**

Along the way, two mechanisms proved themselves rather than being argued about:

- `adk: agent update failed, falling back to create — agentId 17963944182553943980, status 404`.
  The PATCH-then-create fallback is what turns a deleted agent into a recreated one instead
  of a failed run.
- 4 operations rebuilt for `Hubspot agentt` and 2 for `HubSpot Agent`, each wired only to the
  connectors that agent actually references — 13 configured connectors were deliberately not
  wired onto agents that never used them.

**The credential validator fix held (§1.34).** No `invalid_credentials` this run. The only
validation warnings were `code: unverified` on the CUSTOM connector, which is the honest
answer — we have no automated test for a connector we have never seen, and saying so is not
the same as calling the customer's token wrong.

New ids, for anything that pointed at the old ones:

| Agent | old id (deleted) | new id | reasoning engine |
|---|---|---|---|
| HubSpot Agent | 17963944182553943980 | **5539949030633558392** | 2664909971740688384 |
| Hubspot agentt | 16165865784107067164 | **9037777677775865129** | 4572184413932093440 |

Still open and unchanged: the engines these replaced are not deleted (§1.31), so this run
added two more billable orphans.

---

### 1.36 `GetCompanies` 401 — a missing word, not a wrong token (2026-08-13)

The migrated `Hubspot agentt` answered: *"The 'GetCompanies' tool failed due to an
authentication error."* The customer's first suspicion was the older token still sitting in
Secret Manager. It was not that.

`GetCompanies` belongs to the **custom** connector
`shared_get-20crm-20objects-20from-20hubspot-…`, and custom connectors are emitted with
`authHeaderTemplate: '{api_key}'` (`connectorToolBuilder.ts:247`) — deliberately verbatim,
because Power Platform sends whatever the author typed into an apiKey-in-Authorization
security definition. `adk_deploy.py:243` returned that template filled and unmodified, so the
deployed tool called `api.hubapi.com` with:

```
Authorization: pat-na2-…
```

No scheme. HubSpot requires `Bearer `. Registry connectors were never affected —
`shared_hubspotcrm` / `shared_hubspotsettingsv2` declare `'Bearer {api_key}'`. A brand-new
token would have failed identically, which is why "retype the token" was never going to fix
it. Grade: **P** — read from the deployed code path, and the registry/custom split is visible
in both files.

**The old secret was ruled out, on metadata alone.** `spikes/_diag_hubspot_secret_versions.ts`
lists versions only — never `:access`, so no value is read or printed:

```
shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b  (appUserId=default, project=studio-enterprise-migration)
  validation=(none)  savedAt=2026-08-13T05:01:51.718Z
  api_key -> studio-enterprise-hubspot-api-key: v2 ENABLED 2026-08-13T04:20:07.771656Z | v1 ENABLED 2026-08-07T12:45:55.773866Z
```

Tools resolve `versions/latest`, which is v2 (today). v1 is the 2026-08-07 token and backs
nothing. Note also that all four HubSpot connectors share one secret
(`studio-enterprise-hubspot-api-key`), and that the 05:01 saves added **no** new version —
`upsertSecretIfChanged` only writes when the bytes differ, so the value saved at 05:01 was
already v2. Grade: **P**.

**Fix** (`adk_deploy.py`, `_auth_header`): for `bearer` auth, if the resolved header contains
no space it cannot be `<scheme> <credential>`, so `Bearer ` is prefixed. A value the author
did prefix (`Bearer x`, `SSWS x`) has a space and is left untouched — the normalisation can
never override an explicit choice. Grade: **T** — `ast.parse` clean, server typecheck clean;
untested against live HubSpot until the agent is redeployed.

**This needs a redeploy.** `adk_deploy.py` is packaged into the Reasoning Engine at deploy
time, so unlike a rotated token (read at call time) the already-deployed `Hubspot agentt`
keeps the broken header until it is migrated again.

Unrelated but visible above: `validation=(none)` on all four records — the validator verdict
from §1.34 is not being persisted onto `connectorCredentials`. Not yet investigated.

---

### 1.37 The HubSpot agent works, and its one refusal is parity, not a gap (2026-08-13)

Redeployed with §1.36's fix. The run recreated the agent the customer had deleted and
verified it:

```
getAgent 9037777677775865129 failed (404)
Hubspot agentt: the previously migrated agent (9037777677775865129) no longer exists in Gemini - deleted outside this tool. Recreating it.
Hubspot agentt: 4 connector operation(s) rebuilt as exact API calls with the source agent's own arguments.
Hubspot agentt -> gemini-enterprise-17847887_1784788734248/3352958275164371254 - deployed=true shared=true verified=true
```

The customer then asked it real questions and reports accurate HubSpot data coming back.
`GetCompanies` — the operation that produced §1.36's authentication error — now answers.
Grade: **P** for the auth fix; the header change is exercised by every one of the four calls.

**The one refusal is faithful, not a defect.** Asked *"how many contacts are there in sales
qualified leads?"*, the migrated agent said the tools cannot filter by lead status. The SOURCE
Copilot agent refuses identically: *"The Get Contacts tool does not return the lifecycle stage
property, so it's not possible to filter or count contacts by Sales Qualified Lead stage
through this agent."* Both refuse because the agent's own `GetContacts` operation does not
request `lifecyclestage`. Migrating that limitation is correct behaviour — teaching Gemini to
answer it would give the migrated agent a capability the source never had. Filed as a possible
future enhancement (richer property binding / HubSpot search endpoint), NOT as a fidelity loss.

Also logged in the same run, and worth keeping visible:

- `web browsing dropped — ADK can't combine VertexAiSearchTool grounding with googleSearch on
  the same agent` — recorded as a fidelity note, as it should be.
- `ADK agent is ALL_USERS (platform default) but source was not org-wide — auto-granted 1
  principal` — the destination is shared more widely than the source.
- The connectors screen asked for Microsoft and Atlassian credentials for a HubSpot-only
  selection. Harmless at deploy time — the run proves the filter holds:
  `Hubspot agentt: 1 connector(s) apply to this agent; not wiring HubSpot CRM…, Confluence,
  Jira / Atlassian, SharePoint Online, … (configured, but this agent does not reference them).`
  The cause is that the PA-flow scan is environment-wide (`detectThirdPartyConnectors` takes no
  `botIds`; `thirdPartyConnectorScan.ts:4` says so) and the knowledge scan is scoped to the
  browser's `sessionStorage` selection rather than the server-side plan. Cosmetic, unfixed.

---

### 1.38 One stale variable name cost an agent every tool it had (2026-08-13)

Migrating "AA" — the Jira MCP agent — the MCP expansion worked exactly as designed. The fresh
extraction shows the allow-list branch, not the refuse branch:

```
MCP tools: 1
  Jira - Jira MCP Server  connector=shared_jira  sel=specific
  tools=["GetCurrentUser","ListIssues","ListIssues_Datacenter","ListProjects","ListResources","ListIssueTypes_V2"]
AA: 13 connector operation(s) rebuilt as exact API calls with the source agent's own arguments.
AA: 4 topic(s) -> sub-agents in one engine.
```

13 = 6 MCP + 3 direct Jira + 3 HubSpot + 1 Teams. Then the deploy threw:

```
AA: ADK failed (deploy: tool wiring failed: name 'label' is not defined) - falling back to low-code create.
AA -> gemini-enterprise-17847887_1784788734248/8564506214898453052 - deployed=true shared=false verified=true
```

`_make_search_tool(data_store_id, tool_name, source_name)` still referenced `label` in its
body — a parameter rename that left one reference behind. Every knowledge tool raised
`NameError`. Because wiring builds ALL tools in one pass, one bad knowledge tool took the
connector and MCP tools with it, and the low-code fallback produced an agent with **no tools
at all** that still logged `deployed=true verified=true`. This is the invariant restated:
`verified=true` proves the agent answers, never that it kept its capabilities.

The fidelity report was honest — the fallback records `adk-fallback` / `needs-review`: "carries
no live connector tools or topic sub-agents". Only the log line read green.

Fixed to `source_name`. An AST sweep for the same class of defect across the whole file
returned `unbound names: none`. Grade: **T** — parse clean, sweep clean; **P** only once a
redeploy wires 13 tools and Jira answers.

**Other findings from the same run**

- **Google Drive: 11 operations lost**, each named (`ListRootFolder`, `UpdateFile`,
  `ExtractFolderV2`, `GetFileMetadataByPath`, `ListFolder`, `DeleteFile`, `CopyFile`,
  `CreateFileV2`, `GetFileContent`, `GetFileContentByPath`, `GetFileMetadata`). Storing Google
  Drive credentials does not help — the gap is the op emitter, not the token.
- **The Confluence knowledge source cannot be resolved, and no name-matching fix exists.**
  `Confluence crawl failed: None of the requested spaces found: Migration Knowledge Source. The
  space list was read successfully`. The IR shows why:
  `kind: FederatedStructuredSearchSource`, `confluenceSpaceNames: ["Migration Knowledge
  Source"]`, `confluenceSkillConfig: "MigrationKnowledgeSource_O1TAfpFAnMDYe8I4tLvGu"`. Copilot
  stores the COMPONENT name, never the real space name, and the skillConfig id resolves to
  nothing (§ earlier probe). The honest fix is to ask the customer which space it is and store
  that mapping. Reported correctly: `1 knowledge source(s) NOT migrated (needs a connector or
  manual step): Migration Knowledge Source->confluence-crawler`.
- The ACL-loss gate behaved: the first attempt created nothing, listed all three sources, and
  the acknowledged re-run went straight to insert without re-extracting.

---
### 1.39 Drive fails on the DEPLOYED agent while the same auth works live — a stale pickle, not a missing grant (2026-08-13)

Reported as "Jira worked before, after merging it is not working". Measured the opposite on
both counts. Probed the deployed engine directly, because Reasoning Engine logs are useless
here: payload content comes back `"<elided>"` and a 72h `severity>="WARNING"` query returns 0
entries even when a tool hands back `{"error": ...}` — the tool error never reaches the log,
only the user's screen.

```
cd server && npx tsx src/spikes/_diag_probe_connectors.ts

================ JIRA ================
I called `jira_list_projects` ... successful and returned a total of 92 projects.
Next, I called `jira_search` ... This call was also successful and returned 20 recent issues.

================ HUBSPOT ================
I called the `get_companies` tool. It successfully retrieved 5 companies.

================ DRIVE ================
`auth failed (google-service-account): ('unauthorized_client: Client is unauthorized to
retrieve access tokens using this method, or client not authorized for any of the scopes
requested.'...)`
```

**P** — Jira works, HubSpot works, Drive fails **on the deployed agent**.

The first reading of that error was wrong, and the correction matters because it pointed at a
Workspace admin change that must NOT be made. The same credentials, same impersonation, same
DWD flow succeed right now through the production auth path:

```
cd server && npx tsx src/spikes/_diag_check_drive_live.ts

  found secret in project studio-enterprise-migration
customer SA client_email=drive-connector-sa@studio-enterprise-migration.iam.gserviceaccount.com
  impersonating=zara@storefuze.com
status: 200
{ "files": [ {"name": "AI Migration Update"}, {"name": "Gemini-Copilot"}, ... ] }
```

**P** — DWD *is* authorized, for `https://www.googleapis.com/auth/drive`, which is what
`registry.ts` asks for today.

The difference is *when the agent was built*. A deployed agent's scope is frozen into its
pickle at deploy time; it is not read from the registry at inference:

| event | UTC |
|---|---|
| engine `229588473240092672` deployed (`adkDeployments.deployedAt`) | **10:54:31** |
| merge `1ce4894` landed the scope change | **11:10:58** |

Sixteen minutes apart. At deploy time the tree still had the old value; the merge brought in
`d4ac2a4`'s change:

```diff
-    scope: 'https://www.googleapis.com/auth/drive.readonly',
+    scope: 'https://www.googleapis.com/auth/drive',
```

So the running agent requests `drive.readonly` while the domain authorizes `drive`. Domain-wide
delegation matches scope strings **exactly, not hierarchically** — the comment added in that
same commit records this in the `drive` → `drive.readonly` direction, and it holds equally in
reverse: the broader grant does not imply the narrower string.

Fix is a redeploy on current code, not an admin-console change. Adding `drive.readonly` to the
DWD grant would also clear the error, by authorizing a scope the codebase has deliberately
stopped using — do not.

The redeploy needs `forceRedeploy`, because §1.40's drift gap means a re-run of this agent
skips.

What made this look like Jira: the same run logged a real but unrelated failure —
`Confluence crawl failed: None of the requested spaces found: Migration Knowledge Source` —
and Confluence and Jira share the Atlassian credential, so one Atlassian-shaped error in the
log reads as "Atlassian is broken". The Confluence credential is fine; that space name simply
does not exist on the site (§1.31's pattern: the source description echoes the component name
instead of naming a space).

**Standing lesson.** `deployed=true` is not `works=true`, and now also: *the code is not the
agent*. Fixing a connector in the repo changes nothing for agents already deployed. Any
connector fix needs a redeploy before it can be called verified, and the deploy timestamp is
the thing to check first when a fix "did not take".

### 1.40 A renamed Copilot agent never gets renamed in Gemini (2026-08-13)

"There is no knowledge Nexus but it showed already existed." Both true. The agent recorded for
that `sourceId` is live and healthy — under its old name:

```
project=studio-enterprise-migration -> HTTP 200
  displayName = A
  state       = ENABLED
  kind        = ADK
  reasoningEngine = .../reasoningEngines/229588473240092672
```

**P** — the skip was correct; the name was not.

`driftDetector.ts:38` decides whether a re-run does anything:

```ts
export function snapshotFrom(ir: AgentIR, connectorIds: string[] = []): DriftSnapshot {
  return {
    instructions, description, starterPrompts, webBrowsing, codeInterpreter,
    knowledgeFingerprint, connectorIds,
  };
}
```

No `name`. So renaming the source agent produces no drift, `detectDrift` reports unchanged, the
run skips with `already exists`, and the Gemini agent keeps its original display name forever.
Idempotency deliberately keys on `sourceId` rather than display name so a rename updates in
place — but nothing ever notices the rename to trigger that update.

Workaround today: `forceRedeploy`. Fix: add `name` to `DriftSnapshot`, which makes a rename
drift and lets the existing `PATCH ?updateMask=displayName,...` path do what it was built for.


## 2b. Work landed overnight 2026-08-11/12 — graded

Six commits on `business`, all pushed. Graded on the same rule: **P** only if it was run
and produced output, **T** if the compiler and the unit tests have seen it, **U** if
nothing has exercised it.

| # | Change | Where | Evidence | Grade |
|---|--------|-------|----------|-------|
| 1 | ACL-loss acknowledgement gate — a run that would drop source permissions stops between phases unless the plan carries `acknowledgeAclLoss`; dry runs exempt | `services/aclDisclosure.ts`, `orchestrator.ts`, `routes/migrate.ts`, `web/pages/Migrate.tsx` | 13 unit tests over the disclosure logic (fires on copy-and-index / confluence-crawler / dataverse-snapshot, silent on `reconnect` and public sites); typecheck clean both packages | **T** |
| 2 | Five silently-truncating reads now page (`@odata.nextLink`) | `dataverse.ts`, `knowledgeConnectorScan.ts`, `thirdPartyConnectorScan.ts`, `sharePointMigrator.ts` | typecheck + 23 tests; **no tenant here exceeds one page**, so the loop itself is unexercised | **T** |
| 3 | Connector × operation census across both environments | `spikes/_diag_connectors_by_agent.ts` | §1.10 — output pasted | **P** |
| 4 | Swagger coverage: 23 used operations, 23 resolved, 0 missed | `spikes/_probe_swagger_coverage.ts` | §1.11 — output pasted | **P** |
| 5 | Captured operation indexes for 12 connectors (1134 operations) | `connectors/fixtures/*.ops.json` | written by `spikes/_dump_connector_op_index.ts` against the live swagger; the 21 binding tests read these files, so a bad capture fails the suite | **P** (the capture) |
| 6 | `operationBinding.ts` — swagger operation → real vendor request, or a named refusal | `connectors/operationBinding.ts` | 21 tests including every connector × operation pair the census observed | **T** |
| 7 | Readiness surfaced at detection and in the UI | `connectors/readiness.ts`, `knowledgeConnectorScan.ts`, `web/pages/ConnectorConfig.tsx` | typecheck both packages; **never opened in a browser** | **U** |
| 8 | Per-operation `lost` fidelity notes in the insert phase | `orchestrator.ts` | typecheck; no live run produced one | **U** |
| 9 | Build copies `fixtures/` into `dist/` | `scripts/copyAssets.mjs` | `npm run build` → `copied src/connectors/fixtures -> dist/connectors/fixtures`; built server boots (module init clean, `EADDRINUSE` only because the dev server holds :8080) | **P** |

Nothing in this table changes what gets DEPLOYED. The tool builder and
`scripts/adk_deploy.py` are untouched, so a migrated agent still gets the same generic REST
tool it got yesterday. Rows 5-8 make the pipeline able to *say* what it can and cannot
reproduce; making it actually reproduce a bound operation is the next step and is written
up in the plan.

### 2c. The one thing that would move rows 6-8 to P

A deployed agent that calls a bound operation and returns the vendor's real answer. That
needs a redeploy into the customer's Google project, which was deliberately not done in an
unattended session. Until then the honest claim is: *the mapping is proven, the execution
is not.*

---

## 3. Things previously believed, corrected by today's run

Recording these because the plan document asserted them and they were partly wrong.

| Previously written | Actually observed | Correction |
|---|---|---|
| "all 46 of our data stores are `acl=false`" | 47 stores: 44 false, **3 true** | The earlier count came from a probe that printed only the first 25 stores and said `… 21 more`. The truncation was read as a full census. The spike now prints every store. |
| "this project has no native connectors" | **6 native dataConnectors**, two in `RUNNING` state | SharePoint and Google Drive native ingestion was already set up here. The native path is not hypothetical — it is running. |
| "native connectors preserve ACLs (reported)" | Confirmed for **SharePoint and Google Drive**, in this project | Upgrade to `P` for those two. Atlassian remains **U**. |

The first row is the important one: a truncated list was treated as a complete one. That is
exactly the class of error this ledger exists to catch.

---

## 4. Known-red, not yet fixed

### 4.1 `npm run typecheck` fails in `server/`

27 errors, all in `src/spikes/`. The rules exempt spikes from strictness, but
`tsconfig.json` still compiles them, so the command the PR checklist names as the gate
returns non-zero. Either exclude `src/spikes` from the typecheck tsconfig or fix the 27.
Until then "typecheck passes" is only true of app code, and must be said that way.

### 4.2 ~~Nothing is committed or pushed~~ - closed 2026-08-11/12

Everything is pushed to `business`. Section 2's table is a snapshot of that moment and is
kept as written; its grades still stand, because committing code does not execute it.

### 4.4 ~~Connector indexes are captured from ONE tenant~~ — closed 2026-08-12

Indexes are now captured from the customer's own environment and cached
(`connectors/captureOpIndex.ts`, ledger 1.14). Committed fixtures remain the offline
fallback and what the unit tests assert against.

### 4.5 Multi-tenant isolation in Mongo — mostly closed, one step left (updated 2026-08-12)

**Closed:** sign-in exists, every migration-scoped router requires it, and a session id is
no longer a bearer token — asking for another user's session returns `403
session_not_yours` (§1.20, proven). New sessions are stamped with the real owner, and a
cloud connection made without a signed-in user is refused rather than defaulted.

**Left open, by one explicit command:** the ~1017 rows that already exist still carry
`'default'` and stay reachable by any signed-in user, because locking them out would
strand the already-connected customer. `src/scripts/rekeyAppUser.ts --email <account>
--commit` closes it; the dry run is proven, the commit has not been run. Until it is, the
server warns on every boot with the remaining count.

This is now a one-command data migration with a rehearsed dry run, not an unwired design.

### 4.3 The registry does not match the tenant

Four connectors used by live agents have no registry entry (1.10), one of them by 5 of 12
agents. Until the emitter is swagger-driven, those agents migrate with their tools missing
and only a fidelity note to show for it.

---

## 5. How to add a row

1. Run the thing. Capture the command and the output.
2. Paste the **output line**, not a summary of it.
3. Grade it. If you are choosing between `P` and something weaker, it is the weaker one.
4. If the evidence is a name match, a docs statement, or an absence, it is **not** `P` —
   write the inference and label it as one, like §1.3 and §1.4 do.
### 1.41 Parser-vs-LLM blind-spot diff — built, and it found one on its first sweep (2026-08-19)

Ledger §1.23 cost us 26 operations because a topic-embedded `InvokeConnectorAction` was not
the shape the TaskDialog parser expected, and nothing surfaced it until someone dumped raw
refs by hand. `services/blindSpot.ts` automates that check: an LLM reads the same raw payload
the parser read, identifies tools by INTENT, and `diffTools()` reports what only one of them
saw. `llmOnly` is the blind-spot signal.

The LLM never supplies an identifier we bind on — proven necessary in this very run, below.

**Sweep: 12 agents, `org32322095` (`_diag_blind_spot.ts`)** — 38 tools confirmed by both
readers, 3 parser-only, 5 leads to review.

**CONFIRMED FINDING — `InvokeAIBuilderModelAction` inside a topic is absent from `agentTools`.**
Verified against the raw payload with `_dump_component.ts`, agent "D365 Sales - Data
Enrichment", which `extractAgent` reports as **0 tools**:

```yaml
kind: AdaptiveDialog            # component "Field Extraction", componenttype=9
  actions:
    - kind: InvokeAIBuilderModelAction
      id: invokeAIBuilderModelAction_KNOX9p
      aIModelId: 1dab332e-18ee-419c-bb78-a0736981d6a7
```

Scope of the gap, stated precisely — this is NOT a silent loss:
- `dataverse.ts:734` sets a topic-level `usesAiBuilder` flag, so `TopicIR` knows.
- `assess.ts:222` reports it ("the model itself is not migrated").
- But it never becomes an `agentTools` entry, and `agentTools` is what drives tool migration
  and the connector readiness counts. An agent whose only outward call is an AI Builder model
  therefore reports **0 tools**.

Same shape found on "Sales Opportunity Agent - Stakeholder" and 3 topics of "Sales
Qualification Agent Config Assistant". Whether these should become `agentTools` entries is a
product decision (the model is not migratable today); the point of the ledger entry is that
the pipeline can now SEE them.

**Three false-positive classes found and fixed in the same session**, each by real data, each
now covered by a test in `blindSpot.test.ts`:

| Symptom | Cause | Fix |
|---|---|---|
| Knowledge sources reported as tools (SharePoint PDFs, `*SearchSource`, skill configs) | prompt excluded them in one line, with no examples | explicit never/always lists + "could this call fail because an external system was down?" |
| Topic redirects reported as tools (`BeginDialog`, `Topic.X`) | same | added to the never-list |
| `GetPagesBySpace` reported as a blind spot the parser HAD extracted | single-pass greedy matching: model's "Confluence - Get pages" consumed parser's "Confluence - Get pages within a space" by containment | two-pass — every exact match (name / operationId / `foundIn`) claimed before any containment |

Before: 5 of 6 leads were noise. After: "Migrate Advisor" went 26/26 confirmed, 0 false
positives, and the AI Builder finding survived.

**Why the LLM's ids are leads, never bindings — demonstrated here.** For the confirmed
finding the model reported `op=InvokeAIBuilderModelTaskAction` (the real kind is
`InvokeAIBuilderModelAction`) and elsewhere returned the node id where the model id belonged.
It read the intent correctly every time and got the identifier wrong repeatedly. Binding on
that output would have bound nothing, or the wrong operation.

Re-run: `cd server && npx tsx src/spikes/_diag_blind_spot.ts "" <envUrl> <limit>` (needs
`OPENAI_API_KEY`). Confirm any lead with `_dump_component.ts "<agent>" "<component>"`.



### 1.42 The MS connector work is 1 operation, not 340 — measured, then shipped (2026-08-19)

The spec sized Microsoft connector parity off the SWAGGER surface: `office365` 143 +
`sharepointonline` 141 + `onedrive` 56 = **340 blocked operations**, ~3 weeks of mapping.
That number counts every operation the connectors EXPOSE, not the ones anyone calls.

`_diag_ms_op_usage.ts` reads what the staged agents actually reference. Across **131 staged
agents, 2 environments**:

```
Microsoft connector tool references: 14

BLOCKED (needs a hand-written mapping)
    2×  sharepointonline   GetAllTables    Confluence Knowledge Assistant

ALREADY BINDS
   12×  teams              CreateChat      AA, A, knowledge Nexus

WORK QUEUE: 1 distinct operation in demand, against a swagger surface of 340.
```

**Real demand is 0.3% of the estimate.** Mapping in swagger order would have spent weeks
before reaching the only operation a customer actually needs.

**Shipped the same day.** `GetAllTables` ("Get all lists and libraries", input `dataset`)
became `sharepoint_list_lists` in `connector_tools/sharepoint.py` — Graph
`GET /sites/{siteId}/lists`, reusing the `_resolve_scope` URL→siteId conversion the file
tools already had. It lives in the hand-written module rather than `VENDOR_BINDINGS`
because the source takes a site URL and Graph addresses sites by id or by the
`{host}:{path}:` form — a transform no URL template can express.

**New: per-operation rescue on a proxy-only connector.** `VendorBinding.customToolOperations`
and the `custom-tool` binding status. `proxy-only` is a per-CONNECTOR verdict but its reasons
are per-operation, and without this an operation we genuinely reproduce was still reported to
the customer as "will not be recreated" — understating what migrated, which fails the honesty
rule the same way overstating does. `connectorReadiness` now counts these ready and carries a
note stating the NARROWING (the migrated tool is fixed to the connected site; the source could
target any site the signed-in user could reach).

`HttpRequest` deliberately stays refused — a test asserts one custom tool does not rescue the
rest of the connector.

**Caveats, stated because they bound the conclusion:**
- 2 dev tenants, not a real enterprise sample. A customer heavy on Outlook or OneDrive would
  produce a different queue. Re-run per customer — that is what the spike is for.
- It reads `agentTools`, which §1.41 just proved has blind spots (AI Builder actions inside
  topics are absent). If connector actions hide the same way, this UNDERCOUNTS. The blind-spot
  diff is the check for that.
- `teams CreateChat` "already binds" per the table. Binding is not proof it works — no live
  probe has ever called it. See the `verify.ts` gap.


### 1.43 verify.ts no longer passes on silence, and now checks the tools (2026-08-19)

Verification had three code paths that returned `verified: true` with **no evidence at all**:

```
{ verified: true, note: 'deployed (assist probe unavailable: 404)' }
{ verified: true, note: 'deployed (assist probe errored)' }
{ verified: true, note: 'deployed and responded' }   // 200 with no answer text
```

It also never looked at the deployed agent's TOOLS. `expectsGrounding` proved the data
stores were reachable; an agent could deploy with every connector tool missing and pass
every check. That mattered as of the same day: MS connector mapping turned out to be one
operation (S1.42), so verification, not mapping, is what stands between us and a defensible
"it works".

**1. Three-valued status.** `VerifyStatus = 'verified' | 'failed' | 'unknown'`. `unknown`
means the probe could not run - the agent exists, nothing established that it works.
`verified` is now derived as `status === 'verified'`, so every existing caller reading the
boolean fails CLOSED without having to change first. Reported separately from `failed`
because the customer's next action differs: a failure names a defect, an unknown names a
check somebody still owes.

**2. A 200 is not an answer.** The assist endpoint returns 200 for a turn that produced
nothing. That now resolves to `unknown`, not to a pass.

**3. Tool inventory (new level 3).** ADK bakes tools into the Reasoning Engine pickle at
deploy time and no API lists them, so the deployment is asked directly: "list every tool you
have; if none, reply NO TOOLS." Matching is normalised and substring-based so a cosmetic
rename is not a false alarm, and an unreadable answer resolves to `unknown` rather than
either verdict. It reliably catches the case that costs a customer everything - an agent
deployed with NO tools, or a whole connector's worth absent. Missing tools are named in a
`verification:tools` FidelityNote.

**4. Tool names are now extracted structurally.** `adkAgentChat.ts` reads tool names out of
the `function_call` frames (`toolNames`), so "which tools actually fired" is evidence from
the runtime rather than the model's prose.

**5. The UI stopped lying by omission.** A tick-or-dash chip rendered `unknown` as plain
"not verified". `VerifyChip` now shows verified / verification failed / **? unverified** as
three distinct states.

Tests: `verify.test.ts`, 16 cases, one per shipped regression - probe 404, probe threw,
200-with-no-text, answered-without-retrieving, tool-returned-error, NO TOOLS, partially
missing tools, unreadable inventory, and an invariant that `verified` is never true unless
`status === 'verified'`. Suite 155 -> 171.

**Expect more agents to stop reporting verified.** That is the fix working. Those agents
were never proven; they were only never checked.


---

### 1.44 The google-adk pin is proven — a deployed agent answers again (2026-08-19)

**Status: PROVEN LIVE.** Three prior runs failed to establish this for reasons unrelated to
the fix (a version crash, an over-pin of my own, and a run I killed by editing server files
mid-deploy). It is now settled by direct evidence.

Every deployed agent had begun failing *every* query with

```
TypeError: 'NoneType' object is not subscriptable    (llm_agent.py:630, _resolved_model)
```

with **no change on our side**. Root cause: `adk_deploy.py` shipped UNPINNED requirements,
so the container installed a newer `google-adk` than the one that wrote the pickle locally.
The pickle and its runtime silently disagreed. Google shipped a new ADK; our agents broke.

**The proof** (`src/spikes/_test_adk_pin_proof.ts` — one agent, NO grounding, NO connectors,
through the real `publishAgentToGallery` path, so nothing but the pin is under test):

```
deploy     5m03s  ->  state ENABLED
           reasoningEngines/3202579953816174592
query      200, 812 chars, model gemini-2.5-flash
answer     "I am a deployment sanity check."
_resolved_model / NoneType   ABSENT
```

**Only `google-adk` is pinned, and that limit is load-bearing.** Pinning the whole set makes
the RE build FAIL outright: `google-adk 2.6.2` needs `google-genai>=2.9,<3` while
`google-cloud-aiplatform 1.93.0` needs `google-genai<2.0.0` — mutually unsatisfiable in one
pip resolve. The Dockerfile only escapes this by installing in two sequential passes. Pin the
library that owns the pickle; let pip resolve a self-consistent set around it.

Local versions confirming the mechanism: `google-adk==2.6.2` (the pin), 
`google-cloud-aiplatform==1.93.0`, `google-genai==2.16.0` — note genai already sits above
aiplatform's declared ceiling locally, which is the two-pass install showing through.

**Corollary, and it is the expensive part: every agent deployed BEFORE this fix carries the
unpinned requirements and is broken the same way.** They will report `deployed=true` and
answer nothing. They need redeploying, not re-verifying.

**Also fixed here:** the `emit({"info": "reasoning engine requirements"})` line ran *before*
the conditional appends (`google-cloud-discoveryengine`, `pypdf`/`python-docx`/`openpyxl`),
so the log understated what the container actually installed. Moved after the appends —
this log is the first thing read when a build fails, and it was lying by omission.

**Left behind:** reasoning engine `3202579953816174592` / agent `8151998137475559640`
(`ADK-Pin-Proof`) is a throwaway kept as evidence. Billable — delete once read.

---

### 1.45 Outlook -> Gmail: the first cross-vendor connector, proven live (2026-08-19)

**Status: PROVEN LIVE** for read operations. This is the first connector in the codebase
where the VENDOR changes, not just the host.

**The distinction that shapes everything.** `VENDOR_BINDINGS` is same-vendor: it prepends a
base URL and the semantics are identical on both sides (Jira -> Jira). Outlook -> Gmail keeps
the INTENT and rewrites the semantics. No URL template expresses it, so it lives in a new
declarative table, `src/connectors/equivalence.ts`, with a fidelity verdict and a
customer-readable reason on every row.

**The 143-operation number is wrong by 7x.** Measured from
`fixtures/shared_office365.ops.json`:

```
143  advertised
-89  deprecated (Microsoft's own V1/V2/V3 duplicates)
-34  event triggers
────
 49  live   ->  19 of them mail
```

Sizing this work off 143 sizes seven times the real surface.

**Triggers are lost for an AGENT reason, not a Google reason.** 34 operations are event
subscriptions ("when a new email arrives"). A migrated agent is request/response and has no
event loop, so these would be lost migrating Copilot to ANY agent platform. Recorded as one
row, not 34, and the reason says so explicitly - a customer must not read it as a Google
limitation.

**Auth was the gate, and it was a consent line, not a redesign.** `_diag_gmail_dwd_probe.ts`
tests each layer independently so a failure localises:

```
                          mia@cloudfuze.com     zara@storefuze.com (after grant)
1 plain SA token                PASS                    PASS
2 DWD + admin.directory         FAIL                    PASS
3 DWD + gmail.readonly          FAIL                    PASS
4 gmail users.messages.list     SKIP                    PASS  200, 3 message ids
5 DWD + drive.readonly          FAIL                    PASS
```

Two findings from this:

1. **DWD scope matching is EXACT STRING matching.** The Workspace grant already held
   `.../auth/drive`; a request for `.../auth/drive.readonly` was still refused with
   `unauthorized_client`. A broader grant does NOT cover a narrower scope. This cost a wrong
   recommendation before the screenshot corrected it.
2. **cloudfuze.com has no DWD for our SA at all; storefuze.com does.** `unauthorized_client`
   is domain-scoped, so "DWD is broken" was the wrong conclusion from the first run.

**The Drive connector uses a DIFFERENT service account**, `drive-connector-sa` (client id
115592590138196046007), and that client id has NO DWD grant in storefuze.com - both
drive.readonly and gmail.readonly fail for it. This is a sufficient cause for 1.39's
deployed-Drive failure independent of the stale-pickle diagnosis, but it does NOT refute
1.39: that run used a different subject/domain. **1.39 stays open**, deliberately, rather
than being closed on a partial match.

**A live test caught a bug static review would not.** `gmail_search_messages` returned every
message with an empty from/subject/date while `gmail_read_message` on the SAME id returned
them correctly. Cause: `metadataHeaders` is a REPEATED query parameter, and
`urllib.parse.urlencode` without `doseq=True` serialises the list as its Python repr
(`metadataHeaders=%5B%27From%27...`). Gmail matched no header names and returned none. The
API answered 200 every time.

**Proven live** (`_test_gmail_tools.ts`, zara@storefuze.com, through the shipped
`build_tools` contract rather than a reimplementation):

```
gmail_list_labels      661 labels
gmail_search_messages  3 messages, real sender/subject/date
gmail_read_message     full body decoded, attachments=['icon.png'], labels intact
empty-result path      count=0, clean note, no error
```

**Fidelity, computed not tallied** (`_dump_equivalence.ts`): Outlook mail is 18 rows -
**5 exact (28%), 10 narrowed (56%), 3 lost (17%)**; 15/18 = **83% migrates in some form**;
3 rows marked `verified`.

**Read-only by design.** Send/reply/forward are mapped in the table but NOT built. An agent
sending mail in a real person's name is an irreversible outward action and whether a migrated
agent should do it at all is a product decision. Shipping a send tool would have answered it
silently.

**SECURITY DEBT, taken knowingly (user decision, 2026-08-19).** The deployed connector reads
`studio-enterprise-shared-gmail-service-account-json`, which holds the PLATFORM service
account key - the identity that deploys Reasoning Engines and carries `cloud-platform` scope.
A mail-reading container should not hold it. The right shape is a dedicated
`gmail-connector-sa` with no project roles, mirroring `drive-connector-sa`. Swap = create the
SA, grant its client id in Workspace, re-run `_prep_gmail_secrets.ts`. Nothing else changes.

Tests: `equivalence.test.ts`, 19 cases, all honesty invariants rather than shape checks -
every non-exact row must state a reason, `lost` rows may not name a target, `verified`
defaults false so a new row cannot silently claim a proof, and `describeEquivalence` may
never print "Proven live" for an unverified row. Suite 195 -> 214.

**RULE for every connector_tools module: helpers go INSIDE `build_tools`.** The first Gmail
deploy failed outright — the Reasoning Engine could not start and served no traffic:

```
ModuleNotFoundError: No module named 'connector_tools'
Pickle load failed: Missing module. A required module, present when the agent object was
pickled locally, is missing in the remote environment.
```

Cause: `gmail.py` defined `_decode_b64url`, `_strip_html`, `_walk_parts` and `_headers_of` at
MODULE level. cloudpickle serialises the nested tool closures BY VALUE, but a module-level
function they reference is pickled BY REFERENCE as `connector_tools.gmail._walk_parts`, which
the container cannot resolve at unpickle time — even though `extra_packages` ships the
directory.

Every pre-existing module already avoids this, and now the reason is recorded rather than
folklore: `confluence.py:15`, `google_drive.py:24`, `jira.py:22`, `sharepoint.py:27`,
`generic_rest.py:12` — **not one module-level helper between them.** Module-level CONSTANTS
are fine (pickled by value); functions are not.

The failure mode is maximally unhelpful: the deploy reports success at the API layer, the
engine registers, and the whole agent then fails to start. Confirmed on reasoningEngine
`3968754840422580224`; fixed by nesting, no other change.

**PROVEN END TO END from a DEPLOYED agent** (2026-08-19, after nesting the helpers):

```
reasoningEngine 175035104316358656   state ENABLED   secretIamGranted true

"How many labels are in my mailbox?"
    toolCalled=true toolSucceeded=true  tools=["gmail_list_labels"]
    -> "There are 661 labels in your mailbox."

"List my 3 most recent emails with sender and subject."
    toolCalled=true toolSucceeded=true  tools=["gmail_search_messages"]
    -> Mail Delivery Subsystem / Delivery Status Notification (Failure)
       Zara Z / Heloo , collins Welcome,
       Zara Z / (No subject)
```

The evidence is structural, not prose: `function_call` frames naming `gmail_*` tools plus
non-error `function_response`, read with `scanToolEvidence` — the same scanner `verify.ts`
uses. The counts match the local run exactly (661 labels, same three messages), so the
deployed tools are reading the same live mailbox and not a cached or invented answer.

**A Copilot agent that read Outlook mail now reads Gmail from Gemini Enterprise.** First
cross-vendor connector in the product.

**CORRECTION, same day: "19 mail operations" was a filter artifact, not a measurement.**
The user opened Copilot Studio's "Add a tool" menu on a real agent and the list did not match
what §1.45 derived. Cause: the sweep filtered operationIds on `/mail|message|email/`, which
drops every mail operation whose NAME lacks those words — `MarkAsRead_V3`, `AssignCategory`,
`GetOutlookCategoryNames`, `GetAttachment_V2`, `SetAutomaticRepliesSetting_V2`.

Corrected counts, computed by `_dump_equivalence.ts` rather than tallied:

```
                 before (wrong)        after
mail rows              18                23
exact                5 (28%)           6 (26%)
narrowed            10 (56%)          14 (61%)
lost                 3 (17%)           3 (13%)
migrates            15/18 = 83%       20/23 = 87%
```

The "143 is 7x the real surface" line was also wrong — it divided by the bad mail number.
143 -> 49 live operations is **~3x**, and the journey doc now says 3x.

**Lesson worth keeping: keyword matching on identifiers is not a measurement.** The live
authoring UI is a better source of truth for what a customer can actually pick than a regex
over a swagger fixture. This is the second time in two days that real data corrected a
number derived by pattern-matching (see §1.41's greedy-containment false positives).

**NEW FINDING — MCP servers are a tool class the operation model does not describe.** The
same menu offers "Mail MCP" and "Calendar MCP" beside individual actions, and the fixture
carries `mcp_EmailsManagement`, `mcp_ContactsManagement`, `mcp_MeetingManagement` (the first
and third already flagged deprecated, so Microsoft is still moving this).

This changes the migration UNIT. An agent wired to "Mail MCP" is not five connector actions
to map — it is ONE binding to a Microsoft-hosted server whose tool list is only knowable at
runtime, so per-operation fidelity cannot be stated in advance for such an agent. Google ADK
supports MCP toolsets, so the shape is migratable; Microsoft's hosted server is not (it
authenticates against M365 and talks to Outlook). Migrated agents get our Gmail tools
instead — a re-implementation, not a re-binding. Recorded as `MCP_SERVERS` in
`equivalence.ts`: Mail MCP `narrowed`, Calendar and Contacts MCP `lost` (no Google Calendar
or Contacts tools exist in this product at all).

Blind-spot implication, stated because it bounds §1.42's "1 operation of demand" finding:
if a staged agent uses an MCP server, `agentTools` may record one entry for what is really
several capabilities. The MS-demand measurement should be re-run with MCP entries counted
separately before it is quoted again.

**CORRECTION — "87% migrates" was overclaiming, caught by the user asking what it meant.**
The journey doc led with a single percentage over the equivalence table. It counted rows
whose DESTINATION IS KNOWN, and any reader takes "87% migrates" to mean "87% works". The
three numbers are far apart:

```
23  mail capabilities analysed
20  MAPPED   we know the Gmail equivalent and the limits     87%
 4  BUILT    code exists                                     17%
 3  PROVEN   a real call returned real data                  13%
```

What a customer gets today is **3 operations**: search, read, list labels. The 16 rows in
between (reply, forward, move, flag, delete, drafts, send, mark-read, categories,
attachments) are design with no code. "`SendEmailV2` maps to `users.messages.send`" is a
true statement about two APIs and is not a feature.

The denominator flattered us too: 23 is what we CHOSE to analyse, not the connector's size.
The live surface is 49 operations including calendar, contacts and rooms — none analysed,
none built. A percentage over our own list silently excludes what we never looked at.

Fixed: the doc now reports mapped / built / proven as three separate rows and leads with
"what works today is 3 operations". `summarise()` gained a `built` count, and
`equivalence.test.ts` gained 4 tests that make the collapse impossible — mapped must exceed
built, built must be >= verified, a verified row must name a tool, and a mapped row with no
tool is asserted to be NORMAL rather than a defect to be "fixed" by inventing tool names.
Suite 214 -> 218.

**This is the third pattern-matching overclaim in two days** (§1.41 greedy containment,
§1.45 keyword filter, this one). Each was caught by real data or a direct question, never by
review of the derivation. Worth treating as a standing bias rather than three incidents.

**ALL 15 Gmail tools proven live (2026-08-19).** `_test_gmail_all_tools.ts`, 16 assertions,
**0 failures**, against `zara@storefuze.com` through the shipped `build_tools` contract:

```
gmail_list_labels 661 · gmail_search_messages · gmail_read_message · gmail_get_attachment
gmail_create_draft · gmail_list_drafts · gmail_update_draft · gmail_send_draft
gmail_send_message · gmail_reply_to_message (thread=1a01a6919ad7322c — threading correct)
gmail_forward_message · gmail_mark_read (both directions) · gmail_star_message
gmail_modify_labels (+IMPORTANT -STARRED) · gmail_trash_message
```

Test design worth reusing: **every message is self-addressed and trashed afterwards**, so
send/reply/forward are genuinely exercised without a single mail reaching another human. A
send tool that is never tested end to end is a send tool nobody should ship.

`gmail_reply_to_message` returning the ORIGINAL message's threadId is the assertion that
matters — it proves the `In-Reply-To`/`References` headers are set, which is the one Gmail
behaviour that silently degrades (a reply without them starts a new conversation and looks
fine until someone reads the thread).

Counts move accordingly: mail is now **20 mapped / 17 built / 17 proven** (was 20/4/3). The
journey doc and equivalence table are updated, and `equivalence.test.ts` pins the exact
17-row verified set so a future edit cannot quietly widen the claim.

**Scope trap, second instance in one day.** The DWD grant needed `gmail.modify`; the console
screenshot showed 11 scopes and that one absent while 10 others (including 4 added in the
same paste) worked. Diagnosed by probing each scope individually rather than as a set —
`_diag_all_scopes.ts` — which distinguishes "the save landed on the wrong entry" from "one
string is missing". Keep that spike: exact-string matching means this WILL recur per
customer.

**Over-grant found in the customer's console, flagged not fixed:** `cloud-platform` is
listed in the domain-wide delegation entry. It does not belong there — the SA uses it as its
OWN identity for Vertex/Discovery Engine via IAM roles, and in a DWD list it lets the SA
impersonate any user against every Google Cloud API. Removing it breaks nothing.

**SCOPE CORRECTION, from the user: this tool does not migrate mail.** Mailbox migration is a
separate project. What CS_GE does is rebuild the API CALL — the Copilot agent had a tool that
called Outlook; the migrated agent gets a tool that makes the equivalent call at conversation
time. No message is ever copied, indexed or stored. The journey doc said this at line 229
under "Not in scope", which is far too late in a document whose headline reads "Outlook ->
Gmail"; it now leads the document.

**Both destinations are now mapped per operation, not just Google.** An agent with Outlook
tools has THREE real choices, and offering only Gmail-or-nothing quietly forced a mail
migration on anyone who just wanted the agent moved:

```
Keep Outlook   agent moves to Gemini, mail stays in M365 (Graph)   outlook.py, 14 tools
Use Gmail      agent moves and mail moves                          gmail.py,  15 tools
Skip mail      agent migrates with no mail tools
```

`Equivalence.graph` records the Graph call and tool per operation alongside the Gmail one.
The two columns have DIFFERENT fidelity and that is the point: `MoveV2`, `Flag_V2` and the
category operations are `narrowed` against Gmail (folders vs labels, due dates, colours) and
lose nothing against Graph. `GetMailTips_V2` is `lost` against Gmail yet fully available on
Graph — "impossible on Google", not "impossible". A customer keeping Outlook keeps it.

Registry: `shared_outlook` reuses the existing `ms_graph` credential group, so nothing is
re-entered. `shared_office365` stays `proxy-only` and unbindable — its swagger describes a
Power Platform dataset abstraction, so this is a Graph rebuild, not a binding.

**Two mapping gaps were caught by the new tests, not by review** — `SetAutomaticRepliesSetting_V2`
had no Graph mapping at all, and `DeleteEmail_V2` carried an abbreviated path
(`POST .../move`) rather than a real one. Both were in code I had just written and read back.
Consistent with the day's pattern: the assertions find what re-reading does not.

Ordering choice: **Keep Outlook is offered FIRST.** It is the lower-risk option and changes
least about how the agent behaves; leading with Gmail would nudge customers toward a mail
migration they did not ask for. A test asserts the Outlook summary does NOT copy the Gmail
caveats — overclaiming losses on the safer path is its own dishonesty.

Still unproven: the 14 Outlook tools are written and typechecked but NOT exercised against a
live tenant — the Entra app needs `Mail.ReadWrite` and `Mail.Send` APPLICATION permissions
with admin consent. A test asserts every `graph.verified` is false until that happens.

## 1.46 — All 14 Outlook tools proven live against a real mailbox (2026-08-19)

**PROVEN.** The keep-Microsoft path is no longer theory. `_test_outlook_all_tools.ts` against
`alex@filefuze.co` (tenant `807d6772-847c-40e2-9bec-e2c930b3a42e`, app `ConnectorsTest`):
**15 assertions passed, 0 failed** — 14 distinct tools, `outlook_set_categories` covering two
operations. Every message was self-addressed and moved to Deleted Items at the end; nothing
reached another human.

Proven: `list_folders` (17 folders), `search_messages`, `read_message`, `get_attachment`,
`create_draft`, `send_draft`, `send_message`, `reply_to_message`, `forward_message`,
`mark_read` (both directions), `flag_message`, `set_categories`, `move_message` (to Archive),
`delete_message`.

**The failure that got there was worth the round trip.** The first run returned
`ErrorAccessDenied` on all four tools it reached, while `GET /users` worked fine — so the
credential was good and only mail was refused. `ErrorAccessDenied` covers three different
causes (permission absent, consent not granted, Exchange Application Access Policy), and
guessing between them costs a round trip with the customer's admin each time.

`_diag_graph_roles.ts` decodes the minted token's `roles` claim, which is ground truth for the
first two: it lists exactly the application permissions that were granted **and** consented.
Before: four roles, no mail. After: six, including `Mail.ReadWrite` and `Mail.Send`. The
diagnosis was one command, not a conversation. **Delegated permissions never appear in `roles`
on an app-only token** — and the Graph picker defaults to Delegated with identically-named
entries, which is the trap that produced this.

Counts now (computed by `_dump_equivalence.ts`, not tallied by hand):

```
OUTLOOK MAIL -> USE GMAIL          20/23 migrate, 17 proven live
OUTLOOK MAIL -> KEEP OUTLOOK       21/23 mapped to Graph, 15 built, 15 proven live
```

Both columns matter. A row `narrowed` against Gmail is often `exact` against Graph, and
`GetMailTips_V2` is `lost` on Google yet fully available on Graph. "Impossible on Gmail" is
not "impossible".

The stale test asserting `graph.verified === false` for every row was replaced by the
invariant that actually holds: a row claiming `verified` must name a tool, and **every row
naming a tool must be proven live**. A new Graph tool therefore fails the suite until it is
actually run — which is the point. 234 tests across 18 files, typecheck clean.

**Production prerequisite, not built:** `Mail.ReadWrite` as an *application* permission grants
access to **every mailbox in the tenant**. Microsoft's intended narrowing is an Exchange
**Application Access Policy** scoping the app to a mail-enabled security group. Fine for a
test tenant; it must be a documented deployment step before a customer's mail credential runs
through this.

## 1.47 — The customer's own agent, and a false PASS I wrote (2026-08-19)

"Email Manager" was built by hand in Copilot Studio by the customer, so unlike every prior
proof its shape was not chosen by me. Extracted live from Dataverse
(`org32322095`, 0 instruction chars, 0 topics — the author configured tools only):

```
SendEmailV2              mail     -> migrates (narrowed)
GetEmailsV3              mail     -> migrates (narrowed)
GetEventsCalendarViewV3  CALENDAR -> LOST, not in the equivalence table
```

Two of three migrate. **The pass condition was an honest partial**, not three green tools —
three would have meant we invented a calendar mapping.

**GMAIL path: PASS.** RE `2544491458266660864`, `secretIamGranted: true`.
`gmail_search_messages` fired and returned three real messages with senders and subjects.
Asked "what meetings do I have tomorrow?", it answered *"I do not have access to your
calendar"* and called no tool — the lost capability surfaced as a refusal rather than an
invention, which is the behaviour the fidelity rules exist to produce.

**OUTLOOK path: FAILED, and my own checker called it PASS.** The agent answered *"The
authentication to Outlook failed"* while the spike printed `succeeded=true` → `PASS`.

Two separate defects, one in a spike and one in shipped code:

1. **`scanToolEvidence` could not see a connector tool's error.** It tested for
   `"status":"error"`, `PERMISSION_DENIED` and `"error_message"`. Every tool in
   `scripts/connector_tools/` reports failure as `return {"error": "..."}` — a payload that
   rides inside a perfectly well-formed `function_response`. So **any** connector tool
   failing on credentials, scope or an upstream 403 scored as a success, and
   `verify.ts` — which decides verified/failed/unknown from exactly this — would have
   marked it verified. This is the "a 200 is not an answer" bug reappearing one layer in:
   the frame was well-formed, the content was a failure. Fixed, plus three tests including
   one asserting a succeeding tool cannot mask a failing neighbour.

2. **The spike hand-wrote its connector spec and omitted `tokenUrlTemplate`.** The container
   then had no token endpoint, so `_mint_token` could not run. The registry has held the
   right value all along (`login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token`) — the
   product path builds specs through `buildLiveConnectorSpecsDetailed`, which reads it.
   Rewritten to derive from `REGISTRY_BY_ID` so the spike cannot drift from what ships.

Defect 2 was mine and cost only a rerun. Defect 1 was latent in shipped code and would have
reported broken connector agents as verified to a customer. It surfaced only because a real
agent failed in a way I was watching closely — which is the argument for running the
customer's own agents rather than the ones I write.

**Correction to the record:** the `PASS` printed for the Outlook path in the first run of
`_e2e_email_manager.ts` is void.

**Outlook rerun, with both fixes in place: PASS.** RE `3173869506191687680`,
`secretIamGranted: true`. `outlook_search_messages` fired and returned three real messages
through Graph; the calendar question was again refused without inventing a tool. This PASS is
trustworthy in a way the first was not — the corrected `scanToolEvidence` would have caught
the `{"error": ...}` payload that produced the false one.

Honest note on the content: the three messages returned are the self-addressed artifacts from
the 14-tool test (§1.46), not organic mail — that mailbox is quiet. The auth, the Graph call
and the retrieval are real; the messages happen to be ours.

**Both destinations are now proven with the SAME customer-built agent**, which is what makes
the surface choice real rather than aspirational:

```
Email Manager -> Gmail    RE 2544491458266660864   gmail_search_messages    PASS
Email Manager -> Outlook  RE 3173869506191687680   outlook_search_messages  PASS
              -> calendar tool LOST on both, refused honestly on both
```

New guard added the same day: `connectors/registryAuth.test.ts` asserts every OAuth connector
declares a `tokenUrlTemplate` and can reach its credentials. All 9 pass — the registry was
never the offender, only the hand-written spec. Suite: 240 tests, 19 files, typecheck clean.

Four Reasoning Engines from this section need reaping: `2544491458266660864`,
`8324861579996692480` (the failed-auth one), `3173869506191687680`, plus §1.46's.

## 1.48 — Teams + Google Chat built, and keep-Teams turns out to be READ-ONLY (2026-08-20)

Built both paths for Copilot's Teams connector, mirroring the mail work: `chat.py` (11 Google
Chat tools), `teams.py` (Graph), `shared_googlechat` in the registry, a `shared_teams` entry
in `SURFACE_EQUIVALENTS`, dispatch branches in `adk_deploy.py`, and 53 source operations
bucketed into 21 honest rows in `teamsEquivalence.ts`.

**The UI needed no changes at all.** `SURFACE_EQUIVALENTS` is iterated generically by both the
route and the React component, so adding one key produced the whole three-way choice for
Teams agents. That generality was not planned for Teams — it fell out of writing the mail
version without special-casing, and it is the cheapest thing in this codebase.

**THE FINDING, and it contradicts what I told the user an hour earlier.** I said Teams
posting was ungated and READING was gated behind Microsoft's protected-APIs programme. Both
halves were wrong, measured against tenant `807d6772` with app `ConnectorsTest`:

```
READ  channel messages  GET /teams/{id}/channels/{id}/messages   PASS
READ  chat messages     GET /chats/{id}/messages                 PASS (3 messages)
WRITE channel message   POST .../messages      403 "requires one of Teamwork.Migrate.All"
WRITE chat message      POST /chats/{id}/messages
                                               403 "requires one of Teamwork.Migrate.All"
CREATE channel          POST /teams/{id}/channels
                                               403 "requires one of Channel.Create, ..."
```

`ChannelMessage.Send` does not EXIST as an application permission — it is delegated-only,
which is why the user could not find it in the Entra picker. Microsoft's only app-only write
route for Teams messages is `Teamwork.Migrate.All`, the bulk import API, which requires the
team to be in migration mode. Delegated auth would allow posting, but this product is pinned
to app-only `client_credentials` for Microsoft by security-rules.md (delegated resource scopes
trigger `AADSTS65001`). **So the limit is architectural, not a missing grant.**

Consequences, applied rather than noted:
- The three send/reply tools were **removed** from `teams.py`, not left to 403. A tool that
  always fails is worse than an absent one: the model retries it and reports the failure as
  its own, so the customer sees an agent that looks broken instead of one honestly missing a
  capability. `teams_create_channel` stays — `Channel.Create` is a real permission a customer
  can grant.
- The option is renamed **"Keep Teams (read-only)"**. "Keep Teams" reads as "nothing
  changes", and a customer would pick it expecting an agent that can still reply.
- Google Chat is now labelled the ONLY path where a migrated agent can still send. The two
  paths are NOT symmetric here, unlike mail where both read and wrote.

**A test I wrote an hour earlier asserted the wrong thing** — it required the word "protected"
in the keep-Teams prerequisite, encoding my incorrect belief. Corrected to assert
`Teamwork.Migrate.All`. Worth recording: a test can lock in a wrong assumption just as firmly
as a right one, and this one would have defended the error.

Also caught by the probe: `$top` is rejected on `/teams/{id}/channels` and `/joinedTeams`
("Query option 'Top' is not allowed"). `teams.py` sent it on both, so two tools would have
failed live. Now sliced client-side.

Counts (computed by `_dump_equivalence.ts`):

```
TEAMS (53 source operations, bucketed into 21 rows)
  exact 2  narrowed 14  lost 5
  -> USE GOOGLE CHAT   13 rows backed by a built tool, 0 proven live
  -> KEEP TEAMS        12 rows backed by a built tool, 0 proven live
  NOTE: 0 proven. Tools written, none exercised from a deployed agent.
```

**Still unproven and stated as such:** whether domain-wide delegation works for Chat at all.
Gmail worked because DWD lets the SA become the user; Google documents Chat auth differently.
If DWD is unsupported the fallback is registering the SA as a Chat app that must be ADDED to
each space, posting visibly as the app rather than as a person. `chat.py` serves both through
one code path, so no rewrite either way — but it is a real product difference. 256 tests, 20
files, typecheck clean in server and web.

## 1.49 — Chat DWD works for reads; writes need a configured Chat app (2026-08-20)

Probed before deploying anything, which is the point: every finding below cost seconds
instead of a five-minute deploy cycle.

**DWD works for Chat reads.** All six layers of `_diag_chat_dwd_probe.ts` pass impersonating
`zara@storefuze.com` — `spaces.list` returned 25 spaces, `spaces.messages.list` real
messages. The agent acts as a PERSON, not as a visible app. That was the open risk from
§1.48 and it resolved the good way.

At the tool layer (`chat.py` through the shipped `build_tools` contract):

```
chat_list_spaces          PASS  25 spaces (818 with pagination)
chat_list_messages        PASS  real messages
chat_get_message          PASS
chat_list_thread_replies  PASS  threaded=True
chat_list_members         403   needs chat.memberships.readonly — scope was missing
chat_create_space         404   "Google Chat app not found"
chat_send_message         404   "Google Chat app not found"  <- the finding
```

**WRITES REQUIRE A CONFIGURED CHAT APP, AND THAT IS NOT A SCOPE.** Chat message creation
needs the Cloud project to have a Chat app configured (Chat API -> Configuration). Reads do
not. So reading and posting have DIFFERENT prerequisites, and a customer who grants every
scope will read perfectly and never be able to post — a failure that looks like our bug. Now
stated in the registry hint, the option's prerequisite text, `chat.py`, and a test.

Once configured, the agent posts AS THE APP and everyone in the space sees that. Not a
detail: it changes who the message appears to come from.

**Consequence for the customer's own "Teams Coordinator"** (4 tools: `PostMessageToSelf`,
`PostMessageToConversation`, `GetTeam`, `CreateChat` — three of them WRITES):

```
Keep Teams (read-only)  1 of 4 works   only GetTeam
Use Google Chat         reads work; the 3 writes blocked until a Chat app is configured
```

So today that agent cannot be fully migrated either way, and saying so is the honest position.
It also inverts the usual assumption: for THIS agent "keep Microsoft" is the WORSE option,
which is the clearest argument yet for never defaulting the choice.

**Space names now resolve to ids** — `practice_1504` -> `spaces/AAQAMx3E6AU`, verified.
People know space names, not ids, and an agent is told about spaces in the words its user
uses. Ambiguity is REFUSED, never guessed: two spaces called "General" and a tool that picks
the first one posts visibly into the wrong room. Pagination follows `nextPageToken` because a
first-page-only lookup silently "cannot find" a space that exists.

Three of my own bugs caught in the same pass:
- The resolver treated any single word as a bare id and built `spaces/<typo>`, turning a typo
  into a malformed-resource 400 instead of "no such space". Bare ids are indistinguishable
  from names, so they are now refused with instructions.
- `chat_get_message` reported `sender: ''`. Chat returns only `users/{id}` with no display
  name (unlike Graph), so the empty string read as a tool bug. Now explicit.
- A test asserted "unknown space is refused" and PASSED on an auth failure — any-error
  assertions are how false passes happen. Tightened to require the space-specific error. This
  is the second time this session an assertion passed for the wrong reason (§1.47); the
  pattern is mine to watch.

Still not granted: `chat.spaces.create` and `chat.memberships.readonly` (verified absent
per-scope by `_diag_chat_scopes.ts` — 2 of 5 granted on client id 110659723964649683952).

## 1.50 — Tier 1 + HubSpot: every operation real agents call is now judged, and 29 of 34 are proven live (2026-08-20/21)

> **Corrected by §1.52.** Every "N agents" figure below is a count of staged ROWS, not agents (151 rows are 64 agents), and the surface is now 35 operations / 30 proven once HubSpot CMS is included. The judgements stand; the impact numbers do not.

**The question.** "Can we migrate these agents without errors?" cannot be answered from a
swagger surface — `office365` alone exposes 143 operations and nobody calls most of them
(§1.42). The only number that matters is what the customer's OWN staged agents reference. That
is 34 distinct operations across the Tier-1 connectors plus HubSpot.

**Where it started, where it ended.**

```
                        start of session      end of session
proven live                     2                   29
unjudged or lost               28                    0
judged, not proven live         4                    5
```

The 5 remaining are each blocked by something OUTSIDE this codebase, named precisely below.
Nothing is unjudged. That is the whole point: "nobody looked" and "we looked and it cannot be
done" must never render identically in a report.

**The instrument was wrong first, and that mattered more than any single fix.**
`_diag_tier1_coverage.ts` consulted only `equivalence.ts`, which is keyed by `M365Surface`.
`surfaceForConnector` returns null for Drive, Jira, Confluence and HubSpot, so those four were
unjudged BY CONSTRUCTION — finished work reported as a gap, and the gap count was noise. It
also collapsed the two migration paths into one verdict, which listed `GetTeam` as an 11-agent
gap when it is `lost` against Google Chat (no team object exists) and PROVEN on keep-Teams. A
board that mis-scores its own rows sends the night's effort at the wrong things.

**A harness that proves the shipped path, not a reimplementation of it.**
The Confluence and Jira harnesses each re-implemented `secret`, `fill` and `auth_header` before
calling `build_tools`. That proves the spike's idea of the contract — and the contract is
exactly where the expensive bugs live (a module-level helper that pickles by reference, an
empty auth header for the bearer kind). `_lib_live_tools.ts` now calls the REAL entry point,
`adk_deploy._build_live_connector_tool(conn, project)`, fed a `conn` built by the same
`buildLiveConnectorSpecsDetailed` the orchestrator uses.

It also has to reproduce the DEPLOYED SHAPE, which took three corrections, all of which first
looked like product bugs:
- **Drive as the bare service account**: root listed 0 items and every upload 403'd. A service
  account owns no Drive. Drive is only ever deployed alongside a confirmed per-agent
  `impersonate_email` (the orchestrator drops the connector otherwise), so the harness now
  resolves one.
- **Teams with no user**: every tool answered "No user is configured for this agent." That is
  the tool being careful. Only Drive has an `agentConnectorIdentity` record, so the harness now
  ENUMERATES Secret Manager for the right `impersonate_email` rather than guessing names.
- **SharePoint scoped to a file**: `sharepoint_list_files` answered HTTP 422. The orchestrator
  deliberately excludes single-FILE sources from tool scopes ("a scope with no children to
  list"); the harness took `uris[0]` blindly. Now it prefers a folder.

### Bugs found and fixed, none of which a status-code check would have caught

- **HubSpot had NO tool module at all.** All 33 staged agents across three connector ids fell
  through to `generic_rest.py`'s "call any REST API" tool — the shape the model was MEASURED
  declining to use (§Drive/Confluence, 2026-08-10). Written from scratch: 8 tools, proven live.
- **`GetTheDailyApiUsageAndLimitsForAHubspotAccount` has no portal-level endpoint.** Five
  candidate paths 404 on this account; usage is reported per private app. And that endpoint's
  `currentUsage` is a LAGGING SNAPSHOT — it read 0 while the same response header showed 14
  calls used today. Both are now returned, labelled, with the live figure leading. An agent
  quoting the snapshot tells the user zero calls have been made on an active account.
- **HubSpot associations return IDS ONLY.** "Which contacts work at this company?" answered
  with a list of 18-digit numbers is useless, so the tool hydrates them into names in a second
  batch call and surfaces the association LABEL ("Contact with Primary Company"), which is
  often the real answer.
- **Jira `/search/jql` returns no `total`.** `data.get("total", len(issues))` made the agent
  answer **20** to "how many tickets do we have?" The real count is **32,353**, now taken from
  `/search/approximate-count` — or not reported at all, which is the honest alternative.
- **A trashed Drive file read back as a live one.** Every listing filters `trashed = false`,
  but a lookup BY ID returned normal metadata with no indication, so an agent that had just
  trashed a file described it as current. `get_metadata` now returns `trashed`.
- **Every 1:1 Teams chat was named "(no topic)".** A list of ten chats rendered as ten
  identical opaque rows, so "which chat do you mean?" was unanswerable. `$expand=members` now
  names each chat by its participants.
- **"No tickets are linked to that companie."** `type[:-1]` as singularisation. A tool right
  about the data and wrong about the English still reads as broken.
- **My own near-miss:** I nearly deleted the `mcp_JiraIssueManagement` coverage row believing
  it unreachable. Measured instead: `opsByConnector` is built from RAW `ir.agentTools`, where
  the MCP tool still carries that operationId — `boundToolSpec` expands it only downstream. The
  row IS consulted. I had also marked it `verified: true`; the six operations were each called
  live, but the Power Platform MCP proxy has never been callable at all, so it is now `false`
  with a test locking it there.
- **Two contradictions I introduced and reverted:** new `GetAllChannelsForTeam` and `GetChats`
  rows that COVERED existing `ListChannels`/`ListChats` rows while grading them differently —
  two verdicts for one operation, resolved by array order. Folded into the existing rows
  instead. The operations were real and only the SPELLINGS the agents use were missing.

### The 5 that are not proven, and exactly why

| Operation | Agents | Blocker |
|---|---|---|
| `CreateChat` | 29 | Microsoft permits app-only `chatMessage` POST **only for import** (`Teamwork.Migrate.All`). No application permission exists for live sending, so no consent unblocks it. Delegated permissions or a Bot Framework app are different products, not a setting. |
| `PostMessageToConversation` | 11 | Same, measured: 403 "requires one of Teamwork.Migrate.All". On the Chat side, 404 "Google Chat app not found" until a Chat app is configured. |
| `PostMessageToSelf` | 11 | Same — a note-to-self is still a `chatMessage` POST. |
| `mcp_JiraIssueManagement` | 34 | The MCP TRANSPORT is unreproducible (a Copilot MCP tool carries no server URL). All six tools it exposed are reproduced as direct calls, so the capability survives; the dynamic discovery does not. |
| `GetEventsCalendarViewV3` | 1 | `outlook_list_calendar_events` written; Graph answered **ErrorAccessDenied** because `Calendars.Read` (application) is not consented. A tenant grant, separate from the `Mail.*` ones. |

### What the customer must grant (nothing else is outstanding)

1. **`Calendars.Read`** (Application) with admin consent on the app registration → unblocks the
   calendar operation. This is the only item where a grant turns an unproven row into a proven
   one.
2. **A Google Chat app** on the Cloud project (Chat API → Configuration) → unblocks Chat
   writes. Reads already work; writes have a different prerequisite, which is why a customer
   who grants every scope still cannot post (§1.49).
3. Teams message POSTING cannot be unblocked by any grant. If an agent must post into
   Microsoft Teams, that needs a Bot Framework app or delegated sign-in — say so rather than
   promising a permission that does not exist.

### Proven live, by connector

```
Google Drive   11/11 ops   24 assertions   incl. every WRITE, in a scratch folder, round-tripped
HubSpot         3/3  ops   20 assertions   3 connector ids, one module, one token
Jira            6/6  ops   12 assertions   totalApproximate=32,353
Confluence      4/4  ops   10 assertions
Teams (Graph)   3/3  reads  9 assertions   as erik@filefuze.co
SharePoint      2/2  reads  6 assertions   9 named lists; a 12,547-char document read back
Outlook cal     0/1        blocked on Calendars.Read
```

Assertions are round-trips, not status codes: content written is read back and compared, a copy
must carry the bytes, an update must REPLACE rather than append, an extracted zip member must
really appear in Drive, and a listed team must contain the General channel — the last one being
what distinguishes "the call worked" from "the call addressed the team we asked about".

**Suite:** 23 files, 300 tests, `tsc --noEmit` clean in both `server/` and `web/`.

## 1.51 — The tables were right and the report was silent: 13 verdicts that never reached the customer (2026-08-21)

Found while checking whether the night's work would actually be visible to anyone. It would
not have been.

**The mechanism.** `findCoverage` was consulted in exactly ONE place: the loop over
`readiness.blocked` (orchestrator.ts ~2001). There was no loop over the BINDABLE operations,
because a bindable operation normally becomes a real exact-argument replay and the tool IS the
answer. But for a connector with a dedicated Python module the bound spec is DROPPED at deploy
(`connectors/toolModule.ts`) — and the log said, in as many words, *"capability is reported per
operation below"*. For a bindable operation there was nothing below.

**The measurement** (`_diag_bindable_vs_blocked.ts`):

```
Confluence   4 operations   bindable + dedicated module   verified coverage row   NOT REPORTED
Jira         6 operations   bindable + dedicated module   verified coverage row   NOT REPORTED
HubSpot      3 operations   bindable + dedicated module   verified coverage row   NOT REPORTED
Google Drive 11 operations  BLOCKED                       verified coverage row   reported
```

Six of the thirteen are on 34 agents each. Drive was reported only because its operations
happen to be blocked rather than bindable — an accident of the captured swagger, not a design,
which is why this went unnoticed: the connector with the most rows looked fine.

**The fix.** A reporting loop over the dropped bound specs, consulting BOTH tables —
`coverage.ts` (same-vendor, keyed by connectorId) and `equivalence.ts` (cross-vendor, keyed by
`M365Surface`) — and emitting `needs-review` with a specific sentence when neither has a
verdict. An unjudged operation and a judged-and-fine one must not render identically, and
emitting nothing made them identical.

**Two over-reports of my own, in the instrument, in the same hour.** The spike checked only
`findCoverage`, so it twice flagged operations that DO have verdicts — the six Teams ones and
SharePoint's `GetAllTables` live in `equivalence.ts`. Checking one table and concluding about
both is the same error the board itself had at the start of the session (§1.50). It is worth
naming as a pattern: in this codebase there are two verdict tables for two kinds of move, and
any code or diagnostic that consults one of them is wrong until proven otherwise.

**A latent Tier-1 hole found in the same pass.** `surfaceForConnector` mapped
`shared_onedriveforbusiness` — an id that exists nowhere in the registry. The real id is
`shared_onedrive`, which therefore fell through to `null`, so every operation a OneDrive agent
declared resolved to nothing and reported as unjudged. The surface also had ZERO rows. Same
class as the HubSpot ids (§1.10): registry ids guessed from product names rather than measured.
Both fixed; the OneDrive row is deliberately NOT marked verified, because the tools are shared
with SharePoint (which IS proven) and a personal-drive URL shape has never been resolved by
them — sharing a code path with something proven is exactly the argument that would make a
false claim here feel reasonable.

**After:** 0 of 34 operations reach a reporting path without a verdict. `coverageReporting.test.ts`
pins the wiring (4 tests), because the failure mode this guards is SILENCE, which no assertion
on a passing migration run would ever notice.

## 1.52 — Making the CORE solid, and a correction: every agent count in §1.50 was a row count (2026-08-21)

The goal changed shape: not "migrate these agents" but "any agent a customer builds, using any
Tier-1 connector or knowledge source, migrates without errors". That is a property of the core,
and it cannot be established by testing the agents that happen to exist today.

### CORRECTION: §1.50's "N agents" figures were staged ROWS, not agents

`stagedAgents` holds one row per agent PER RUN, and this tenant has re-extracted dozens of
times. **151 rows are 64 distinct agents.** The board incremented a counter per row, so every
per-operation figure it printed — and every figure quoted from it into §1.50 and to the user —
was inflated by a factor that varies per connector. The measured truth is much flatter.

The two figures §1.50 actually put a number on, re-measured (`_diag_row_vs_agent.ts`):

| §1.50 claim | what it said | measured rows | measured DISTINCT agents |
|---|---|---|---|
| Teams `GetTeam` "an 11-agent gap" | 11 agents | 11 | **1** |
| HubSpot "all 33 staged agents across three connector ids" | 33 agents | 25 | **3** |

The `GetTeam` figure was exactly the row count. The `33` reproduces as NOTHING — not rows (25),
not tool references (48), not references to any id containing "hubspot" (126) — so it was not
even consistently wrong; it was a number carried between runs and never re-derived. The
per-operation figures quoted verbally were row counts of the same kind.

No operation in the whole Tier-1 surface is used by more than 3 agents. The WORK was not
misdirected — every connector and operation is real, and is genuinely referenced — but the
impact numbers were wrong, and impact numbers are what got used to decide what to build first.
`_diag_tier1_coverage.ts` now accumulates a `Set` keyed on `sourceId` (the stable Dataverse id,
falling back to displayName, and to `_id` for a row with neither so two unknowns cannot merge).

A second correction, smaller: I drafted this entry with per-connector counts from memory before
re-running the board. They were wrong too — invented, plausible, and higher than the truth. The
table above is what the instrument printed. **Do not write a number into this ledger that has
not just been measured.**

### A hand-written list can only have gaps in connectors someone already thought of

The board iterates a literal `TIER1` array. `_diag_connector_census.ts` instead reads every
connector id and knowledge-source kind that any agent has EVER referenced (stagedAgents +
agentIRCache) and asks three questions per id: registry entry, tool module, verdict. It found
two ids the list never contained:

- **`shared_hubspotcms`** (1 agent, `TemplatesList`) — and in the worst possible state.
  `hasDedicatedToolModule` answers TRUE for it, because the Python dispatch matches any kind
  starting `hubspot`, so the pipeline announced that its bound operations had been dropped in
  favour of purpose-built tools — while no registry entry existed, so no spec was built and the
  agent received NO TOOL AT ALL. Registry entry added, `hubspot_list_templates` written, and
  the id added back into `TIER1` so the board covers it.
- **`shared_get-20crm-20objects-20from-20hubspot-…`** (**2** agents, 78 tool references — the
  "5 agents" I said earlier was another figure never re-derived) — a CUSTOM connector, resolved
  at runtime through the custom-connector path, which needs a live capture context and so is
  invisible to an offline census. Noted rather than "fixed": it already works, having rebuilt
  four operations on the "Hubspot agentt" run.

### HubSpot CMS: a different scope family, and a token echoed back inside an error

Measured on portal 246967746: `/cms/v3/design-manager/templates` **404s** — templates exist
only on the legacy `/content/api/v2/templates`, which answers **403** naming the scopes it
wants (`design-manager-access`, `content-editor-access`, `landingpages-read`). CMS access is a
different scope family from CRM and is not implied by it, so this is the `Calendars.Read`
pattern again: a grant only the customer can make, where the tool's job is to NAME the missing
scope instead of returning a bare 403. Because a private app's scopes are fixed at creation,
adding one means issuing a new token.

**A credential leak found inside that same 403.** HubSpot echoes the token back in the response
body, and `_request` was putting that body straight into the error `detail` — which reaches the
logs and the agent's own reply to the user. This project's rules forbid logging token values at
all. Now redacted to `pat-[redacted]` before the detail is used for anything.

### The core-robustness matrix: 14 tests over agent shapes that do not exist yet

`services/coreRobustness.test.ts` drives the core path over SYNTHETIC agents — every Tier-1
connector at once on ONE agent, an unknown connector, a tool with no operation, an empty agent,
every knowledge-source kind ever observed, and kinds no agent has ever used. The bar is not
"it works" but "nothing throws and nothing goes quiet". Properties now pinned:

- A connector with a dedicated Python module must ALSO have a registry entry — exactly the
  combination `shared_hubspotcms` was in, and the one that produces a silent no-tool agent.
- One agent using every Tier-1 operation must produce UNIQUE tool names. Two connectors once
  collided on names and 400'd every message (live, 2026-08-07), so this is a measured failure
  mode, not a hypothetical.
- A genuinely unrecognised knowledge-source kind must reach `manual-review`, be
  `automatable: false`, and NAME the kind in its note.

### Two of my own assumptions, corrected by the test I had just written

Both were the same error — encoding my guess about a rule, then calling the rule wrong:

1. I asserted `AzureBlobKnowledgeSource` must be `manual-review`. It is `copy-and-index` with
   `automatable: false` and a note saying it needs the customer's blob credentials. That is the
   classifier being right; my assertion conflated "has a strategy" with "claims to be automatic".
2. I then asserted `AzureAiSearchSource` must produce an `agent-tool`. It is deliberately
   `manual-review` / `none`, because a prebuilt index cannot be moved, and its note names the
   two options a human has.

The test now asserts the PROPERTY — every claimed kind either names something concrete it will
build, or defers to a human, and never neither — instead of a table of my expectations. A test
that encodes the author's guess about each rule only tests the guess.

### Where Tier-1 stands, measured this hour

```
35 operation(s) used across Tier-1 connectors (incl. HubSpot CMS)
30 proven live, 0 unjudged or lost, 5 judged but not proven live
```

The 5 unproven are each blocked OUTSIDE our code: three Teams writes (`CreateChat`,
`PostMessageToSelf`, `PostMessageToConversation`) by Microsoft's import-only rule for app-only
`chatMessage` POSTs; `mcp_JiraIssueManagement` by a Power Platform MCP proxy that has never
been callable; `TemplatesList` by the missing CMS scope above. 151/151 staged rows build tool
specs with no exception, and 14/14 connectors pass the live pre-flight.

**Suite:** 25 files, 318 tests, `tsc --noEmit` clean in `server/` and `web/`.

### Still the blocker for an end-to-end run

`migrationSessions` is empty (Mongo TTL) and a session requires a real browser OAuth sign-in,
which I cannot perform. Everything reachable without one is green. `forceRedeploy` is now wired
through the web client, so a re-run of an already-migrated agent stops being silently skipped.

## 1.53 — Two live migrations, and the worst bug this project has had (2026-08-21)

Six agents migrated through the UI across two runs, then interrogated over the API. Four
deployed, one skipped correctly, one failed on a network drop. Questioning them found three
bugs that a green run had reported as success, and one of them hands an agent another agent's
tools.

### The severe one: every ADK deploy staged its package to the SAME GCS object

`agent_engines.create()` was called without `gcs_dir_name`. The SDK defaults it to the literal
`agent_engine`, so EVERY deploy in a project pickles its agent to:

```
gs://<staging-bucket>/agent_engine/agent_engine.pkl
```

Two deploys in flight together overwrite each other, and both containers get built from
whichever package landed last.

**Measured, not theorised.** "Hubspot agentt" (deploy started 11:47:32) and "Email Manager"
(11:47:50) produced two correctly-named engines — `displayName` right on both — created in the
SAME SECOND, 11:48:35. Asked what tools they had, BOTH answered with Email Manager's 16 Outlook
tools. The HubSpot agent had none of its own four. A control question to two engines from the
earlier run returned their own correct tools, so the harness was not the confusion.

What makes this the worst bug so far is the failure mode, not the frequency:

- Verification caught it only because the two toolsets DIFFERED (`none of the 4 wired tool(s)
  are present`). Two agents sharing a connector would have swapped packages silently, both
  passing verification.
- Multi-tenant, this is one customer's agent running another customer's tools — with that
  customer's connector identities baked in.
- The function's own docblock has said *"Deploy takes ~2-5 min. Callers should run this with
  low concurrency"* since it was written, while the orchestrator ran `concurrency 5`. **A
  comment is not an enforcement.** Nothing had to change for this to start happening; it was
  latent from the first concurrent run.

Fixed by passing a per-deploy `--gcs-dir` (`agent_engine/<sanitized-name>-<uuid>`) through to
`gcs_dir_name`. `adkStagingIsolation.test.ts` (4 tests) drives the real `deployReasoningEngine`
against a worker that echoes its argv: the flag must be present, unique across two different
agents, unique across two deploys of the SAME agent (a retry must not reuse a path), and
confined to the `agent_engine/` prefix with no traversal from a Copilot display name. All four
FAIL with the fix removed — verified by removing it.

### One function, two opposite wiring bugs, on one agent

`agentConnectorIds` decides which connectors get wired onto an agent. On "Knowledge Assistant"
it did both possible things wrong at once:

**Wired Confluence the agent never had.** The rule matched `/confluence/i` against
`classification.notes`, and the note it matched is the one that RULES CONFLUENCE OUT:

> `Ambiguous "FederatedStructuredSearchSource" kind with no Confluence-matching description …`

Proven by counterfactual, not by reading: blank the notes and every connector disappeared, so
the substring was the sole cause. Neither real signal (`strategy === 'confluence-crawler'`,
`confluenceSpaceNames`) was present. Blast radius measured across all 64 distinct agents: 1.

**Did not wire SharePoint the agent did have.** The rule keyed on
`kind === 'SharePointSearchSource'`. These sources carry `FederatedStructuredSearchSource`, so
five real SharePoint sources were wired nothing — while the same run logged *"SharePoint: 5
source(s) served by live tools (list/read, scoped to the folders this agent named)"*. The
classifier had declined to copy them PRECISELY BECAUSE live tools would serve them. Confirmed
by asking the deployed agent, which answered *"I cannot directly access SharePoint folders"*.

Both are the same underlying error, and it is the `hubspotcms` shape again (§1.52): a verdict
inferred from something that was never meant to carry it. The fix moves the answer to the only
place that knows it — `KnowledgeClassification.requiresConnectorId`, stamped by the classifier
rule that already did the disambiguation — and `agentConnectorIds` now reads that field.
Structural fallbacks (`strategy`, `confluenceSpaceNames`, the raw SharePoint kind) stay for
`stagedAgents` rows classified by earlier releases, which outlive a deploy. The prose match is
gone. `connectorWiring.test.ts` (8 tests), of which the two that name these bugs fail on the
old logic — verified.

Verified on the real agent afterwards: re-classified, it needs `shared_sharepointonline` and
NOT `shared_confluence`. Every run re-extracts and re-classifies in Phase 1, so the next run
gets this without a backfill.

### A cleanup I talked myself out of, and should have checked first

I reported "36 of 42 data stores attached to no engine" and offered to delete them to free the
`documents_regional` quota. That metric was the wrong question. An ADK-migrated agent grounds
through `groundingDataStores` resource paths baked INTO its Reasoning Engine; it never appears
in `engine.dataStoreIds`. "Not attached to an engine" is therefore the NORMAL state for exactly
the stores that matter, and deleting on that signal would have silently un-grounded live
migrated agents.

Cross-referencing our own records instead (`adkKnowledgeStores`, `knowledgeConnectors`,
`migrationResults`) leaves 31 of 44 claimed by nothing — but that list still contains
`ca57b355-…-tbl-cr88d-faqentries`, which the LIVE Knowledge Assistant queries through
`search_faq_entry`. So the records only track uploaded FILES, not Dataverse or connector-backed
stores. **Nothing was deleted.** Safe cleanup needs that tracking gap closed first; until then
the quota needs a Google increase, not a purge. The near miss is the lesson: a destructive
action justified by a metric nobody checked against the mechanism.

### Smaller, from the same runs

- **`documents_regional` quota exhausted**: `FAQ Entry` indexed 0/20 rows, so the agent's
  Dataverse grounding is empty. It reports this honestly when asked — *"empty or contains no
  relevant information"* — rather than inventing an answer, and verification failed the agent
  for it (`the agent answered without retrieving anything`). Deployed is not working, and the
  pipeline said so.
- **A 404 logged as WARN on the normal path.** `upsertSecretIfChanged` reads before writing to
  compare; a secret being written for the FIRST time 404s, and every per-agent identity printed
  `WARN Secret Manager: access version failed`. A warning that fires on the happy path teaches
  people to ignore warnings. Both comparison reads now pass `{ optional: true }` and log at
  debug for a 404 only — any other status still warns.
- **Deploy timeout left an anonymous orphan.** Killing the Python worker does not cancel the
  create, so the engine finishes building with nobody holding its id. The timeout error now
  names the agent and location so it can be reaped instead of joining the other forty.
- **Five identical calendar rows.** `outlook_list_calendar_events` returned "STEST11" five times
  with identical start and end — indistinguishable from the tool repeating itself. They are five
  real separate entries, so the fix is `id` on every event plus a `duplicateEntries` note, NOT
  deduplication: collapsing them would delete events the calendar actually contains.
- **The ACL gate held.** The first attempt stopped with *nothing created* because one Confluence
  source cannot carry its permissions; the re-run recorded the acknowledgement. Separately the
  crawl then failed because the space `Migration Knowledge Source` does not exist on the site at
  all — so the gate blocked a run over a source that could never have been migrated. Ordering
  worth revisiting; not yet changed.

### What answered correctly, live

Teams Coordinator: 25 real Google Chat spaces, real messages in `finance`, and an honest *"No
user is configured for this agent"* on the Teams side rather than a fake answer. Email Manager:
10 real calendar events through the new `Calendars.Read` path. Knowledge Assistant: the PRD PDF
quoted with `[INDEXED]`, 22 Confluence spaces, and the full Deployment Guide page with a `[LIVE]`
citation carrying the real Atlassian URL. Nothing hallucinated in any answer.

### Re-run after the fix — the staging collision is closed, proven end to end

"Hubspot agentt" deleted from the destination and migrated again, alone, through the real HTTP
API (reusing the operator's own browser login session — the sign-in had happened; nothing
bypassed `requireAuth`):

```
BEFORE (concurrent with Email Manager):  deployed=true verified=FALSE
   tools on the deployment: call_office365_api + 15 outlook_* ...  (Email Manager's)
AFTER  (with per-deploy gcs_dir_name):   deployed=true verified=TRUE
   tools on the deployment: get_deals, get_tickets, get_companies, get_contacts  (its own)
```

Live answers from the redeployed agent: `get_companies` -> 9 real companies, `get_deals` -> 6
real deals with amounts, `get_contacts` -> real contacts. `get_tickets` fails with an honest
scope error ("the necessary scope for this API call is not available") — the HubSpot `tickets`
scope is not on the private app token, which is a customer grant, not a defect. Three of four
proven live; the fourth proven to report its blocker instead of inventing an answer.

Also confirmed on the way: the agent had been deleted in the Gemini console, so the stored
deployment record 404'd and the pipeline recreated it — the recreate-after-out-of-band-delete
path (§ADK notes, fixed 2026-08-13) ran for real and produced a working agent.

**Note on the server log.** A duplicate `npm run dev` truncated the log file while the original
process kept writing at its own offset, so the log tail became unreliable mid-investigation and
the run's outcome had to be read from `migrationResults` instead. Read state from the database,
not from a file another process owns.

**Suite:** 27 files, 330 tests (+12), `tsc --noEmit` clean in `server/` and `web/`, all Python
modules parse.

## 1.54 — SharePoint tools were unusable against any real tenant; three bugs, found by asking (2026-08-22)

The connector-wiring fix (§1.53) put SharePoint tools on the agent that needed them. Asking that
agent to use them found the tools themselves had never worked against a real tenant. Each bug
hid the next, so each was only visible after the one before it was fixed.

1. **Paths were not percent-encoded.** urllib refuses outright rather than encoding:
   `URL can't contain control characters ... (found at least ' ')`. Real SharePoint paths are
   full of spaces and brackets — `Microsoft Teams Chat Files`,
   `Ben file 2[1]_1779290909_6257.pdf` — so every SharePoint tool failed on its first call
   against any tenant whose folders have spaces in the name, which is all of them.

2. **Personal sites were not parsed.** `_resolve_scope` understood `/sites/<name>/…` only. A
   OneDrive-for-Business URL is `https://<tenant>-my.sharepoint.com/personal/<user>/Documents/…`,
   so `personal` fell to the root-site branch: it resolved the -my host's ROOT site and then
   looked for `personal/<user>/…` as a folder inside that site's drive. Graph answers 404 and
   the agent reports *"the default SharePoint folder is not configured"* — a parsing bug wearing
   a setup problem's clothes. **Teams chat attachments always live on a personal site**, so any
   agent grounded on a file shared in a Teams chat hit this.

3. **A single-file scope broke reading.** `read_file` joined the caller's filename onto the
   scope, and when the scope IS the file that builds `.../Ben file.pdf/Ben file.pdf` → 404. The
   model cannot know: `list_files` had just correctly reported the one file, so asking to read
   it by name is the obvious next move. `list_files` now detects a file scope and says so;
   `read_file` accepts the empty ask, the exact name, or the full path, and refuses anything
   else as outside scope.

**Proven end to end afterwards**: the deployed agent listed its file, then returned the extracted
PDF text. Path with a space AND brackets, on a personal site, scoped to one file — every one of
the three conditions that used to fail.

Also fixed in the same pass: **ADK deploys now retry once on a transport failure**
(`ENOTFOUND`, `ConnectionResetError(10054)`, `Connection aborted`). Two of seven deploys over
2026-08-21/22 were lost to the network alone, and the fallback is not graceful — a low-code agent
carries no connector tools, no topic sub-agents, and cannot be un-privated through any API. One
of those failures also left a PRIVATE tool-less DUPLICATE of an agent that had deployed correctly
minutes earlier, while `adkDeployments` still pointed at the good one. The retry is deliberately
narrow: transport only, never a bad spec, quota or auth error, which fail identically twice.

**Lesson, repeated from §1.53:** every one of these deployed green. `deployed=true`,
`verified=true`, no warnings. They were found by asking the agent to do its job.

**Suite:** 28 files, 337 tests, `tsc --noEmit` clean in `server/` and `web/`.
