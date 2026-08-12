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

**Still open from this run.** `detTools=0` on both agents during staging, while the
connector step detected 3 connectors for the same two agents — the two counts disagree
and only one of them can be right. That is the same shape of contradiction as §1.17a and
is NOT yet explained.

**And the login page is not a login page.** `web/src/pages/Login.tsx` POSTs to
`/api/login`, which does not exist; anything other than a 401 proceeds, so any input
signs in. `verifyLogin` in `db/repos/users.ts` is written and unused. This is §4.5's
launch blocker seen from the front: multi-tenant isolation cannot be real while the
identity is unauthenticated. Grade **X** against "the app has sign-in".

---

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

### 4.5 Multi-tenant isolation in Mongo is still nominal

Every scoped collection filters by `appUserId`, and every row in every one of them is
`'default'`, because no route sets it. Credential SECRETS are now keyed by
`credentialScope(session)` (1.15), but Mongo is not: two customers on one deployment would
see each other's sessions, staged agents, deployments and IR cache.

The fix is either wiring sign-in (the `appUsers` collection and bcrypt hashing already
exist, only the route is missing) or re-keying the collections to `credentialScope`. Both
are data migrations and neither should be done as a side effect of feature work.

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
