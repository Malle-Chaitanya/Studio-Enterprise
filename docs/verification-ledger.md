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
