<!-- /autoplan restore point: ~/.gstack/projects/Malle-Chaitanya-Studio-Enterprise/business-autoplan-restore-20260811-190945.md -->

# Plan — Connector & Tool Transformation

Make any Copilot Studio agent's connectors and tools migrate to Gemini faithfully, and
know **before** the run whether each one will work.

Status: **draft, under review**. Branch `business`.

---

## Problem

Today a connector migrates as a guess.

We extract `connectorId` + `operationId` from Dataverse — `shared_jira` + `ListIssues` —
and then throw the operation away. On the Gemini side the agent gets one of two things:

- a **hand-written Python tool** for the four kinds someone bothered to write
  (`sharepoint`, `jira`, `confluence`), which approximates what the source did, or
- `call_external_api(path, method, body)` for everything else, which hands the model a
  base URL and asks it to invent the path.

So "migrated" means "a tool with a similar name exists". Whether it makes the same API
call the Copilot agent made is unknown, untested, and in the generic case unlikely.

Three consequences, all live today:

1. We cannot answer "will this agent work after migration?" before running it.
2. We ask for credentials per *connector* from a hand-written static list, so a read-only
   agent is asked for the same permissions as a write-heavy one.
3. Adding a connector means editing a 773-line registry **and** a 1,300-line Python file
   with `if kind == "jira"` branches. It does not scale to "any connector".

---

## What the research established

Proven live 2026-08-11 — see [verification-ledger.md](verification-ledger.md) §1.7.
Do not re-derive.

| Finding | Consequence |
|---|---|
| Power Apps connector API returns per-connector **swagger**, using the app-only token we **already mint** (audience `https://service.powerapps.com`, `$filter=environment eq '<envId>'&$expand=swagger`) | The schema source exists and needs no new consent |
| The `operationId` we extract **is a key into that swagger** — `GetPages`, `HttpRequest` both matched with typed parameters | Operations become mechanically resolvable |
| `shared_confluence` = 5 operations; `shared_sharepointonline` = 141 | Real scale of what a connector exposes |
| Paths are Power Platform **proxy** paths: `GET /{connectionId}/ex/confluence/{cloudId}/wiki/api/v2/pages` | `{connectionId}` is a PP connection we will **not** have at runtime |
| Confluence is a thin pass-through; SharePoint's `datasets/{dataset}/httprequest` is a PP construct with **no provider equivalent** | Prefix-stripping does **not** generalise — hence a per-connector layer |
| Dataverse `connectors` table: 0 rows. TaskDialog payload: `operationId` + `modelDescription` + `outputs`, no verb/path/param types | Neither is a sufficient source alone |
| Both connector tools in the test tenant carry `connectionProperties.mode: Invoker` | Per-user auth is the norm, not the exception |
| Gemini `authorizations`: 200, 0 existing, our SA can list | The per-user mechanism is available and unused |
| 3 of 47 data stores have `aclEnabled: true`, all from native connectors; our 44 are all `false`, immutable | Indexed knowledge loses ACLs and cannot be retrofitted |

---

## Design

### D1. Real ETL — land raw, transform separately

Today `orchestrator.ts:652-673` extracts, transforms and maps in one pass, then stages the
finished `MappedAgent`. Re-transforming means re-reading Dataverse.

Proposed:

```
EXTRACT   Dataverse ──→ rawAgents      (verbatim botcomponents + bot record, per agent)
TRANSFORM rawAgents  ──→ stagedAgents  (AgentIR + MappedAgent)   ← re-runnable, offline
INSERT    stagedAgents ──→ Gemini
```

New collection `rawAgents`, keyed `(appUserId, envUrl, sourceId, runId)`, holding the
unparsed **structural** component rows and the bot record. Transform reads only from Mongo.

Why it matters beyond tidiness: **every parser change today requires a live re-extract to
test.** With raw landed, a parser fix can be replayed against that tenant's real payloads
instead of a fixture someone invented.

**Constraints on `rawAgents` — decided, not optional:**

- **Opt-in per run, 7-day retention.** Off by default. Enabled per run as *"retain source
  payloads for 7 days for support"*, surfaced in the UI so there is a real moment where the
  customer agrees. Window lives in `config.ts`, not scattered in the repo.
  *Decided 2026-08-12.* The original design stated both "keep it so parsers can be replayed"
  and "TTL it for privacy" as if compatible. They are not: parser bugs surface weeks after a
  run; a defensible window is days. 7 days plus an explicit opt-in resolves it honestly, and
  the regression value moves to committed swagger fixtures (below), which are not customer
  data at all.
- **What is actually sensitive here is the topic YAML** in `data`/`content` — customer
  business logic and message text. **Not** uploaded file bytes: the `$select` at
  `dataverse.ts:974` takes `filedata_name`, not `filedata`, and bytes are fetched separately
  at migration time (`dataverse.ts:346`). An earlier draft of this document had that
  backwards and reached the right conclusion from a false premise.
- **Single-tenant scope.** No cross-customer corpus. If we ever want one it is opt-in,
  anonymised, and agreed in writing — a separate decision, not a side effect of this one.
- **One retention policy across all three stores.** `rawAgents`, `stagedAgents` and
  `agentIRCache` hold overlapping copies of the same content at three fidelities. TTL'ing
  only the newest one is a cosmetic control.
- **The regression corpus is `server/src/connectors/fixtures/<id>.swagger.json`** — Microsoft's
  public connector definitions. 33 files, committable, diffable, no TTL, no consent story.
  They give unit tests for the whole emitter and turn schema drift into a `git diff`.
- **BSON limit.** One document per component, not one per agent; oversize payloads go to GCS
  with a pointer. Use `dvGetAll` (`dataverse.ts:388`) before landing — the current `dvGet` +
  `$top=1000` silently truncates large agents. Store the row count and a `truncated` flag.

### D2. One module per connector

```
server/src/connectors/
  types.ts                 ConnectorModule contract
  registry.ts              index — imports modules, no per-connector data
  modules/
    confluence.ts          metadata · credentials · auth · operations · emitter · capability
    jira.ts
    sharepoint.ts
    hubspot.ts
    ...
  generic/
    swaggerOperation.ts    operationId → typed tool, for connectors with no module
    proxyPath.ts           PP proxy path → provider path, where the shape allows
```

The `ConnectorModule` contract, roughly:

```ts
export interface ConnectorModule {
  id: string;                          // 'shared_jira'
  meta: { name; category; icon; docsUrl };
  credentials: CredentialField[];
  credentialGroup?: string;
  auth: AuthSpec;                      // kind, tokenUrl, scope, basic fields
  /** Per-operation support. The honest answer to "will this migrate?" */
  operations: Record<string, OperationSupport>;
  /** Minimum permissions for a given operation set — not a static per-connector list. */
  permissionsFor(operationIds: string[]): PermissionRequirement[];
  /** Emit the Python tool(s) for the operations this agent actually uses. */
  emit(ops: ResolvedOperation[], ctx: EmitContext): ToolSpec[];
  /** Live probe: does this operation actually work with these credentials? */
  validate(ops: string[], creds: CredentialValues): Promise<OperationValidation[]>;
}
```

Adding a connector = adding a file. A connector with no module falls through to the
generic swagger path and is **labelled as such**, never silently.

### D3. Transform, don't guess

For each `AgentToolIR`:

```
operationId ──→ swagger (cached per connector+environment)
             ──→ verb, path, typed params, response shape
             ──→ module.emit()  ── or ──  generic emitter
             ──→ a Python tool that makes THAT call
```

Three tiers, and every tool records which tier produced it:

| Tier | Meaning | Fidelity |
|---|---|---|
| **verified** | A live call with the customer's own credentials returned data | proven |
| **unverified** | A tool was emitted; nothing has called it | **stated as unproven** |
| **unsupported** | No module and the proxy shape has no provider equivalent | **`lost` FidelityNote** |

Two tiers, not three — decided in review. The original design had a middle tier called
`derived`, described in its own table as *"high, unverified per-op"*, and rendered it to
customers before the validator that would make it true existed. That is the exact failure
this plan opens by condemning. There is no fidelity word we are entitled to use for a call
nobody has made. `verified` requires a probe; everything else says so.

### The kill list — capabilities we will not reproduce

Some operations cannot be migrated faithfully without removing a safety control. Those go
on a kill list: never emitted, always reported, and **excluded from the stopping-rule
denominator** so refusing them can never look like failing to reach the target.

| Operation | Why refused | Decided |
|---|---|---|
| `shared_sharepointonline` / `HttpRequest` | Copilot's own description: *"may execute any SharePoint REST API you have access to."* Our SharePoint tools are **deliberately narrower than the source** (`adk_deploy.py:249-258`) — locked to the folder the agent named, because the app credential carries `Sites.Read.All` and `registry.ts:691` records that **there is no per-site application permission**. Reproducing it means handing every user of an org-wide agent read access to all 99 sites in the tenant. | **2026-08-12** |

Refusal is not silence. Each entry emits a `lost` FidelityNote naming exactly what the
source agent could do that the migration will not, so the customer decides what to do about
it with full information. To be recorded in `.claude/memory/decisions.md`.

This matters to the stopping rule: SharePoint accounts for 141 of the operations observed,
and its flagship operation is one we refuse. Whether ≥90% is reachable depends on the
denominator excluding kill-list entries — which it now does.

### D4. Pre-flight capability report

Before any run, for the selected agents:

```
Agent "Enterprise Migration Knowledge"
  shared_jira        4 operations   4 exact
  shared_confluence  1 operation    1 exact       ⚠ Invoker — per-user auth not preserved
  shared_zendesk     2 operations   0 supported   ✗ will not work after migration
```

Surfaced in the UI before Migrate is clickable, and again in the report after.

### D5. Credential ask derived from operations

`/connector-requirements` takes the agent's **operations**, not just connector ids, and
returns the minimum permission set for exactly those. A read-only Jira agent asks for read
scopes; it stops asking for write.

### D6. Validation per operation

`connectorValidator` moves from "is this credential live" to "does each operation this
agent uses actually return data". Result per operation, surfaced at save time:

```
shared_jira   Search        ok
              GetIssue      ok
              CreateIssue   403 — token lacks write scope
```

### D7. User-level access — two problems

| | Problem | Fix |
|---|---|---|
| **Tools** | `Invoker` operations flatten onto one shared credential | Gemini `authorizations` + `authorizationConfig.toolAuthorizations` |
| **Knowledge** | Indexed documents lose source ACLs, `aclEnabled` immutable | ACL-preserving ingestion, or an explicit disclosure gate |

These are independent. Fixing tools does nothing for indexed knowledge. Both must be
stated honestly in the report until fixed.

---

## Sequencing — REVISED after CEO review

Decided 2026-08-11: **safety and evidence before breadth.** Both reviewers independently
rated the original order the 6-month regret scenario. The connector work is not cancelled;
it is gated on evidence that says how much of it to build.

Every step names the artifact that moves it to grade **P** in
[verification-ledger.md](verification-ledger.md). No step starts until the previous one has
a P row. That discipline is applied to this plan, not just to the code it describes.

| # | Step | Why here | P-milestone |
|---|---|---|---|
| **0** | Land the 22 unpushed commits + 15 uncommitted changes. Green the `server/` typecheck gate (exclude `src/spikes` or fix the 27). Move 3 in-flight changes from T/U to **P**. | The binding constraint today is that nothing is proven and nothing is shipped. All of §2 is one `git checkout` from vanishing. | 3 new P rows; `npm run typecheck` exits 0 |
| **1** | **ACL-loss acknowledgement gate.** Not the fix — the disclosure. Migration of a source with restricted knowledge requires an explicit acknowledgement. | Days of work. Ends a live exposure that is proven, shipped, and undisclosed. A security reviewer finding it first plausibly ends the account. | gate blocks an un-acknowledged run, observed |
| **2** | **Connector × operation census** across every agent ever extracted. Histogram of `connectorId × operationId`; count agents with zero connectors. | Hours of work. Evidence says 2 connector families in the real tenant and 28 of 33 registry entries have never made a live call. This may cut steps 5–7 by 80%. | histogram published in the ledger |
| **3** | **Swagger coverage probe** — all 33 connectors, not the 2 probed. Plus: can the proxy→provider rewrite be a rule? Commit each fetched swagger as a fixture. **Requires the `https://service.powerapps.com` audience** — a third app-only grant we do **not** hold today; name it and its admin-consent requirement in the customer permissions doc first. | Everything downstream of D3 assumes yes, and the ledger grades it **U** for 31 of 33. | per-connector coverage table in the ledger; 33 fixtures committed |
| **3b** | **The binding question.** Dump full TaskDialog payloads for every tool we hold and determine whether the arguments the source agent bound are recoverable at all. | D3's core claim is "a tool that makes THAT call". `parseAgentTool` captures no inputs. If bindings are absent, the honest ceiling is a typed signature with model-supplied arguments — a different product claim. | answer recorded in the ledger, with the payload evidence |
| **4** | **Backbone bake-off** — one Jira op and one Confluence op, three ways: hand-written module · ADK `OpenAPIToolset` fed our swagger · Integration Connectors + `ApplicationIntegrationToolset`. Score: works / per-user auth possible / who maintains it / cost. | Decided in review. A hand-written module system is only justified where all three fail. | scored comparison in the ledger |
| **5** | **Operation-derived credential ask** (D5), scoped to the census's top connectors. Plain lookup table — does **not** wait for `ConnectorModule`. | Highest commercial ROI item in the plan. `Sites.Read.All` across 99 sites for an agent that named one folder is what stalls a security review. | a read-only agent asks for read scopes only |
| **6** | **Per-operation validation** (D6) — before the capability report, not after. | A report that asserts fidelity for calls nobody made is the failure this plan condemns. | per-op result observed for one real agent |
| **7** | **Capability report** (D4), built only on verified/unverified. | Now it has something true to say. | report matches the validator's output |
| **8** | `rawAgents` + transform split (D1), with the F5 constraints. | Real value, no longer load-bearing for everything else. | transform re-runs offline, no Dataverse call |
| **9** | Connector modules (D2) / generic emitter (D3) — **shape decided by steps 2–4**, not by this document. | Build what the evidence says exists. | ≥90% of observed operations reach `verified` |
| **10** | Per-user tool auth via Gemini `authorizations` (D7 tools half). | The mechanism is confirmed available and unused. | one authorization created and consumed |
| **11** | ACL-preserving ingestion (D7 knowledge half). | The real fix behind step 1's disclosure. | a store created with `aclEnabled: true` |

**Stopping rule.** Connector work stops when ≥90% of operations observed across all
migrated customer agents reach `verified`, and the remainder are labelled and acknowledged.
Without a number, step 9 is an open-ended treadmill — there is always one more connector.

---

## Open questions

**Resolved in review:**

- ~~Does the swagger fetch work for all 33 connectors?~~ → **step 3**, not an open question.
- ~~Can the proxy→provider rewrite be a rule?~~ → the ledger already answers *no, not
  generally* (Confluence yes by inference, SharePoint no by observation). Step 3 quantifies
  how often. `generic/proxyPath.ts` is not assumed to exist until then.
- ~~Block or warn on an unsupported operation?~~ → **never block; migrate with a mandatory
  acknowledgement**, same mechanism as the ACL gate. Blocking makes the tool look worse than
  a hand migration and pushes customers to disable the check. To be recorded in
  `.claude/memory/decisions.md`.

**Still open, and genuinely unanswered:**

- Whose OAuth app backs per-user authorizations: ours, the customer's, or the platform's?
- **Why does a customer pay to migrate an agent rather than re-author it?** Both reviewers
  flagged that this founding premise is unstated anywhere in `docs/`. Needs one page: who
  buys, why not re-author, what the window is, and what remains valuable if Google ships a
  first-party importer.
- What is the equivalence story? componenttype **19 is the customer's own evaluation sets**,
  already extracted and explicitly not migrated — a free per-agent test corpus. `verify.ts`
  already asks the migrated agent a real question; the missing half is asking the **source**
  agent the same one. Flagged by Claude as the 10x candidate; not yet in the sequence
  because it depends on whether the source Copilot agent is programmatically invocable.

---

## Eng review — dual voices (2026-08-11)

```
ENG DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════
  Dimension                             Claude   Codex   Consensus
  ────────────────────────────────────  ──────   ─────   ─────────
  1. Architecture sound?                 NO       NO      CONFIRMED
  2. Test coverage sufficient?           NO       NO      CONFIRMED
  3. Performance risks addressed?        NO       NO      CONFIRMED
  4. Security threats covered?           NO       NO      CONFIRMED
  5. Error paths handled?                NO       NO      CONFIRMED
  6. Deployment risk manageable?         NO       n/a     single-voice
═══════════════════════════════════════════════════════════════
```

### Live bugs found — verified against the code, not plan risks

| Finding | Evidence | Status |
|---|---|---|
| **`listStaged` is a cross-tenant read** | `db/repos/staged.ts:137` filters `{ runId }` only. `security-rules.md` names `stagedAgents` explicitly as requiring `appUserId`. Indexes omit it (`db/mongo.ts:96`). | **CONFIRMED — one-line leak, live today** |
| **Custom connectors are silently dropped** | `connectorIdFromConnectionReference` matches `/\b(shared_[a-z0-9_]+)/i` only (`dataverse.ts:583`). A custom connector yields `undefined`, so `agentConnectorIds()` never sees it — it does not even reach `unsupported[]`, so **no `lost` note is emitted**. | **CONFIRMED — found by both voices independently** |
| **`state["_tool_calls"]` is written and never read** | `adk_deploy.py:1105` records it; `grep -rn "_tool_calls" src/` returns **zero hits**. The observability the tier system depends on is discarded. | **CONFIRMED** |
| **Extraction truncates at 1000 components** | `extractAgent` uses `dvGet` + `$top=1000` (`dataverse.ts:971`); the paginating `dvGetAll` exists at `:388` and is not used. | **CONFIRMED** |

### Correction to this document

My own F5 rationale was **wrong**. I wrote that componenttype-14 rows carry uploaded file
**bytes**. The `$select` at `dataverse.ts:974` takes `filedata_name`, not `filedata` — bytes
are fetched separately at migration time (`dataverse.ts:346`). The right conclusion
(one document per component, TTL, purge) was reached from a false premise. The actual
sensitive payload is `data`/`content`: topic YAML carrying customer business logic and
message text. Believing "we don't copy bytes" solves the privacy problem is exactly the
error this correction prevents.

### The finding that threatens the core claim

**H1 — CRITICAL.** D3's central claim is `operationId → swagger → a Python tool that makes
THAT call`. Swagger gives the **signature**. It does not give what the Copilot agent
**bound the arguments to** — topic variables, user input, or literals. `parseAgentTool`
(`dataverse.ts:626-642`) captures kind, connectorId, operationId, displayName, description,
outputs, authMode. **No inputs. No bindings.**

So a typed tool is still a tool whose arguments the model invents — the same guess as
`call_external_api`, with better parameter names and a fixed path. A real improvement, but
**not** "a tool that makes that call". Deleting the `derived` tier did not delete the state
it described. → surfaced as a taste decision.

### Other confirmed findings, both voices

- **Transform is not actually offline.** Mapping already depends on durable connector and
  destination state loaded outside Dataverse (`orchestrator.ts:599,661`). Either transform
  reads live state (so "offline" is false) or it snapshots that too (so `rawAgents` is not
  the only handoff). Unaddressed, this stages **stale** `MappedAgent`s whenever credentials
  or the destination change between extract and insert.
- **D1's benefit is half-built.** `cacheAgentIR()` (`orchestrator.ts:744`) already persists
  `AgentIR` **and** `MappedAgent`. Mapper-layer replay exists. What is not replayable is the
  parser layer. Scope `rawAgents` to that, and apply one retention policy across all three
  overlapping stores (`rawAgents`, `stagedAgents`, `agentIRCache`) or the privacy control is
  cosmetic.
- **The TTL and the replay justification are mutually exclusive.** Parser bugs surface weeks
  later; a defensible TTL is days. Name the constant, make raw landing opt-in per run.
- **Swagger fetch has no token cache, no backoff, no budget.** `clientCredsToken`
  (`microsoft.ts:72`) mints a fresh token every call; `rateLimiter.ts` is Gemini-write-only.
  Fetch once per (env, connector) — never per agent — or the fan-out is quadratic.
- **Cache key must carry the tenant.** "Per connector+environment" ignores `appUserId`, the
  scoping the rest of the codebase uses precisely because shared projects already caused
  cross-customer leakage.
- **Per-operation validation is underspecified and unsafe.** You cannot validate a write
  without performing it — `CreateIssue` creates a real ticket in the customer's Jira the
  first time an admin clicks Save. And the extractor preserves no parameter values, so many
  probes cannot be constructed faithfully at all.
- **`verified` measures the wrong thing.** A server-side probe with the customer's
  credentials does not prove the **deployed tool** works. They diverge at the proxy→provider
  rewrite, the container's Secret Manager read (403 visible only at inference), and the
  model declining to call the tool at all.
- **Step 5 is bigger than claimed.** `/connector-requirements` takes connector ids and
  returns static registry permissions. Operation granularity needs a new API contract, a new
  op→scope taxonomy, and merge rules for siblings sharing a credential group.
  Worse: `registry.ts:691` already records *"there is no per-site application permission"* —
  so D5 delivers **zero** on the `Sites.Read.All` example used to justify its rank. It
  delivers real value for Atlassian and HubSpot only.
- **No test plan exists.** D2/D3/D5 introduce exactly the pure data-in/data-out functions
  the testing rule says to unit-test first.

### Auto-decided fixes (applied to the plan)

| # | Fix | Principle |
|---|---|---|
| 9 | Fix `listStaged` (`appUserId` + compound index) and custom-connector extraction **in step 0**, before the census — a census run on the blind spot measures the blind spot and calls it evidence | P1 |
| 10 | `emit()` returns a **declarative operation descriptor** (verb, path template, typed params, auth kind, response projection) consumed by one generic Python builder. Never generated Python source — the agent is cloudpickled (`adk_deploy.py:712`) and `exec`-created functions do not pickle by reference | P5 |
| 11 | Split each module into `def.ts` (pure data, importable by routes) · `emit.ts` (build-time) · `probe.ts` (network). `registry.ts` re-exports `def.ts` only, preserving the zero-import property routes depend on | P5 |
| 12 | **GET/HEAD probes only, derived from the swagger verb.** Every write operation is reported `unverified` **by policy, permanently**, and the report says so | P1 |
| 13 | Two words, not one: `credential-verified` (server probe) and `tool-verified` (the deployed agent called it and got data, read from `_tool_calls`). Only `tool-verified` counts toward the stopping rule. Wire `_tool_calls` into `verify.ts` | P1 |
| 14 | Add a `schema-unavailable` outcome — retryable, never emits `lost`. A 429 is not a permanent capability loss | P1 |
| 15 | **Commit `server/src/connectors/fixtures/<id>.swagger.json`.** These are Microsoft's public connector definitions — not customer data. 33 files, diffable, no TTL, no consent story. Resolves the test gap, schema drift, and most of the privacy problem at once | P1 |
| 16 | Land `vitest` in step 0 alongside the typecheck fix | P1 |
| 17 | Token cache per `(tenant, resource)` until `exp − 60s`; swagger cache keyed `(appUserId, tenant, envId, connectorId)` with hash + `fetchedAt`; fetch once per (env, connector) | P1 |
| 18 | Stopping rule is **per run** ("this migration reached X% tool-verified"), not a global metric — the global version needs the cross-customer corpus the plan forbids | P3 |
| 19 | Stamp `transformVersion` on staged rows; a version bump counts as drift, so a transform-side fix reaches already-migrated agents without `forceRedeploy` | P5 |
| 20 | Add step 3b: **answer the binding question** from the raw TaskDialog payloads before any of step 9 | P1 |
| 21 | Use `dvGetAll` before landing raw; store row count + `truncated` flag | P1 |
| 22 | Name the third audience (`https://service.powerapps.com`) and its admin-consent requirement in the customer permissions doc **before** step 3 | P1 |

## Decision audit trail

| # | Phase | Decision | Class | Principle | Rationale |
|---|---|---|---|---|---|
| 1 | CEO | Reorder: safety + census before connector breadth | **User challenge** | user decided | Both models rated the original order the 6-month regret. User chose the reorder. |
| 2 | CEO | Run the three-way backbone bake-off before building modules | **User challenge** | user decided | ADK `OpenAPIToolset` / Integration Connectors could delete D2 and most of D3. |
| 3 | CEO | `rawAgents` holds structural payloads only; TTL + purge; per-component docs; no cross-customer corpus | Mechanical | P1 completeness | Type-14 rows are customer documents; 16 MB BSON cap; existing security rule already forbids the weaker form. |
| 4 | CEO | Collapse three fidelity tiers to two (`verified` / `unverified`) | Mechanical | P1 completeness | No fidelity word is earned for a call nobody made. |
| 5 | CEO | Move per-operation validation ahead of the capability report | Mechanical | P1 completeness | A report built on unverified claims is the failure the plan condemns. |
| 6 | CEO | Never block on an unsupported operation; migrate with mandatory acknowledgement | Mechanical | P6 bias to action | Blocking pushes customers to disable the check. |
| 7 | CEO | Attach a P-milestone to every step; gate each step on the previous one's P row | Mechanical | P1 completeness | The plan holds itself to the standard it sets for the code. |
| 8 | CEO | Set a numeric stopping rule (≥90% observed operations `verified`) | Mechanical | P3 pragmatic | Without it, connector work never ends. |
| 23 | Eng | **Probe the binding question first (step 3b), then name the state** | **Taste — user decided** | user | Swagger gives the signature; the arguments the source bound are not in Dataverse. Find out whether they are recoverable at all before choosing a fidelity word for it. |
| 24 | Eng | **Refuse SharePoint `HttpRequest`.** Kill list, `lost` note, excluded from denominator | **Taste — user decided** | user | Reproducing it removes a folder-scoping control added on purpose. Fidelity that deletes a safety control is not fidelity worth shipping. |
| 25 | Eng | **`rawAgents` opt-in per run, 7-day retention**; regression corpus is committed swagger fixtures | **Taste — user decided** | user | "Keep for replay" and "delete for privacy" were both asserted and are incompatible. Opt-in + 7 days is defensible; the fixtures carry the testing value without customer data. |

---

## CEO review — dual voices (2026-08-11)

### Consensus table

```
CEO DUAL VOICES — CONSENSUS TABLE
═══════════════════════════════════════════════════════════════
  Dimension                             Claude   Codex   Consensus
  ────────────────────────────────────  ──────   ─────   ─────────
  1. Premises valid?                     NO       NO      CONFIRMED
  2. Right problem to solve?             NO       NO      CONFIRMED
  3. Scope calibration correct?          NO       NO      CONFIRMED
  4. Alternatives explored enough?       NO       NO      CONFIRMED
  5. Competitive/market risks covered?   NO       NO      CONFIRMED
  6. 6-month trajectory sound?           NO       NO      CONFIRMED
═══════════════════════════════════════════════════════════════
6/6 CONFIRMED. Zero disagreements on direction; one disagreement on posture (below).
```

### CODEX SAYS (CEO — strategy challenge)

1. Optimising connector fidelity before proving it is the bottleneck customers pay for.
   The repo's own docs say the harder trust break is **access** fidelity. "If the migrated
   agent can technically call the right Jira endpoint but violates source permissions, that
   is not a better product. It is a more dangerous one."
2. "Any connector" is **structurally false** — many operations are Power Platform transport
   details, not product features. SharePoint `HttpRequest` may not be faithfully
   reproducible at all. The real unit of work is per-connector × per-auth-mode ×
   per-operation-family, sometimes per-tenant. "An integration company cost structure
   presented as a product platform narrative."
3. Sequencing is strategically backwards — better pre-flight reporting on an unsafe
   migration is "nicer instrumentation on a broken value proposition."
4. The capability report may be a **sales deterrent**, not leverage: customers may hear
   "half my estate will not migrate."
5. D1's raw-ETL split is infrastructure for a universe of migrations we may not want.
6. Competitive asymmetry — MS and Google change platform primitives faster than we can
   maintain a connector taxonomy. Durable moat is migration **assurance**, not emulation.
7. Enterprises approve known integration patterns, not dynamically synthesised
   least-privilege claims from reverse-engineered swagger. D5/D6 improve UX, not procurement.
8. Need a thesis on when **not** to migrate a capability — else "not faithful enough to
   trust, not constrained enough to approve."
9. Wrong KPI. Not "migrate more agents" — "board-safe agent migration with auditable trust
   boundaries." Certification, policy gating, rollback, post-migration evidence.
10. Dismissed alternative: productise **safe non-migration** — explicit manual-handoff
    artifacts, the mechanism we already have in `FidelityNote` / `PermissionHandoff`.

Missing: segmentation thesis, a kill list, a business threshold for "faithful enough", a
competitive answer, a decision rule for block-vs-warn.

### CLAUDE SUBAGENT (CEO — strategic independence)

- **F1 CRITICAL** — this plan silently restates `production-hardening-plan.md` Stream C
  (#11/#12/#14/#15) and Stream A (#8/#19/#23/#25) as D1–D7, and **inverts** its stated
  order. That plan says Stream A "should move first" because it has a live security
  consequence; this one schedules identity as items 7–8 of 8. Two authoritative documents,
  contradictory orders, no supersession note.
- **F2 CRITICAL** — ADK ships `OpenAPIToolset` (OpenAPI → typed tools, no Python emitter)
  and `ApplicationIntegrationToolset` (Google Integration Connectors, ~100 SaaS systems
  with managed auth). Never evaluated as the backbone. Could delete D2 and most of D3.
- **F3 CRITICAL** — we are building for "any connector" without counting which connectors
  exist. Evidence shows **two** connector families in the real tenant; 28 of 33 registry
  entries have never made a live call. A `connectorId × operationId` census is hours of
  work and may shrink this plan by 80%.
- **F4 CRITICAL** — the 10x reframe: **prove equivalence, don't perfect the rebuild.**
  D4 answers "did our transformer produce a tool it believes in" — a self-graded exam.
  componenttype **19 is the customer's own evaluation sets**, already extracted, explicitly
  not migrated: a free per-agent test corpus. `verify.ts` already asks the migrated agent a
  real question; the missing half is asking the **source** agent the same one.
- **F5 CRITICAL** — D1 as written creates an indefinite cross-customer lake of verbatim
  customer data, and states that as the benefit. Type-14 rows carry **uploaded
  knowledge-file bytes**. No TTL, no purge, no consent story. Also unsound mechanically:
  verbatim `filedata` will breach Mongo's **16 MB BSON limit**.
- **HIGH** — the plan violates the honesty invariant it quotes: D3 ships a `derived` tier
  labelled "high, unverified", D4 renders it to customers at step 5, and D6 (the thing that
  would make it true) is step 6.
- **HIGH** — the cheapest disqualifying experiment ("does swagger work for all 33?") is
  filed as an Open Question instead of task #1.
- **HIGH** — ACL disclosure is step 8 of 8. It is a checkbox and a paragraph, and its
  absence is plausibly a notifiable event.
- **HIGH** — D5 is the highest commercial ROI item and is ranked 5th. `Sites.Read.All`
  across 99 sites for an agent that named one folder is what stalls a security review.
- **MEDIUM** — no owner, no estimate, no definition of done. "Adding a connector = adding a
  file" is false: the file must also carry a live `validate()` against a real tenant.

### DISAGREE — the one posture split

Codex says exhaustive pre-flight honesty can kill deals; narrow to a few certified
patterns instead. Claude says the honesty ledger **is** the moat. Both agree on narrowing;
they differ on how much to show the customer. → surfaced as a taste decision.

## Constraints

ESM TypeScript with `.js` import specifiers · native `mongodb` driver, no ODM · every
migration-scoped query filters by `appUserId` · no secrets in git or logs · best-effort
persistence must degrade, not crash · **a lossy mapping must emit a `FidelityNote` — a 200
is not an answer, `deployed=true` is not `works=true`.**
