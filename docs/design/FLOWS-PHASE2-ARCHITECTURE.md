# Phase 2 Design: Migrating Copilot Studio Flows (Power Automate) to Headless GCP Infrastructure

Status: **design only — no code written**. Execution shape (headless GCP infrastructure,
not an agent-tool surface) was decided by the user — see `.claude/memory/decisions.md`,
**2026-09-03 — Phase 2 (flows/workflows) execution shape**. That decision (headless vs.
agent-tool) is NOT reopened by this document. What IS revised here, per a same-day
re-decision the user explicitly requested (`.claude/memory/decisions.md`, **2026-09-03 —
Phase 2 headless execution engine re-decision: Application Integration over Cloud
Workflows**), is **which headless GCP product implements the headless execution** — the
original version of this document assumed Cloud Workflows + Cloud Scheduler + Cloud
Run/Eventarc as the only headless option; a head-to-head researcher pass against Google
Cloud **Application Integration** (never evaluated before either prior decision) changed
that conclusion. §5, §6.1, §7, §9, and §10 below are revised accordingly; §1–4 and §8 are
materially unchanged (the platform-neutral `FlowIR` contract, the extraction model, and
the two-phase boundary do not depend on which downstream GCP product consumes the IR).

**This revision is a recommendation, not yet approved for implementation.** Per this
project's own rule that an IR/execution-contract-shape decision belongs to product, not to
an implementing session or peer agent, this needs the user's own explicit sign-off before
`flowMapper.ts`/`flowDeployer.ts` are built — see the "Decision to record" section (§12).

This document does not re-litigate the headless-vs-agent-tool decision. It designs
everything downstream of it.

---

## 1. Summary

Phase 2 extracts Copilot Studio "flows" (Dataverse `workflows` rows with `category eq 5`,
Power Automate) into a new platform-neutral `FlowIR`, maps each one — keyed by trigger
type — into a headless GCP execution artifact (as of this revision: a Google Cloud
**Application Integration** `Integration` resource with `triggerConfigs`/`taskConfigs`,
previously designed as a Cloud Workflows YAML + Cloud Scheduler job / Cloud Run+Eventarc
trigger), stages the mapped result in Mongo exactly like Phase 1 agents, and then
deploys/verifies it against GCP in a second pass. It reuses `parseFlowId()`
(`services/toolPayload.ts:265`) as the join key back to `AgentIR`, reuses
`secretManager.ts` untouched for the Entra credentials a flow's Dataverse calls need at
runtime, and introduces a brand-new verification story because `services/verify.ts`
cannot reach headless infrastructure at all. It touches every pipeline stage
(extract → IR → map → create → verify → report) but as a **parallel pipeline**, not a
modification of the agent one — `AgentIR`, `stagedAgents`, `orchestrator.ts`'s
`runMigration()`, and `verify.ts` are all read, never changed, except for one small,
additive cross-reference (§3).

## 2. What already exists and is reused as-is

| Existing piece | Role in this design |
|---|---|
| `services/dataverse.ts:1838` (`inventory()`'s `flowCount`) | Confirms the OData query and the `category eq 5` filter; extraction reuses the same query, expanded to `$select=workflowid,name,clientdata,statecode,createdon,modifiedon,ownerid,ismanaged` |
| `services/toolPayload.ts:265` `parseFlowId()` | The **only** join key between `AgentIR` and `FlowIR` — an `AgentToolIR` with `kind: 'flow'` carries `flowId`, which equals a `FlowIR.sourceId` (the Dataverse `workflowid`). No parallel/duplicate join mechanism is introduced. Unaffected by the engine re-decision — this join key sits entirely above the execution-engine boundary. |
| `services/secretManager.ts` (full set) | Reused unchanged for the Entra `client_id`/`client_secret`/`tenant_id` a deployed flow's Dataverse REST calls need at runtime. Same create-then-add-version-with-409-as-idempotent convention, same "secrets live in the customer's GCP project" placement, same preflight-before-deploy pattern (`preflightSecretAccess`) used for agent connector credentials today. Reused identically regardless of execution engine. |
| `db/repos/entraAppCredentials.ts` / collection `entraAppCredentials` | Reused, not duplicated. This already stores "which Secret Manager secret backs this Microsoft tenant's Entra app-only credential," keyed `{appUserId, tenantId}`. A flow's Dataverse/Graph calls need exactly this same credential shape (app-only `client_credentials`, same as Phase-1 extraction's own token fetch) — no new secret-reference collection is designed for this. |
| `docs/verification-ledger.md` conventions, `services/verify.ts`'s three-state truth (`verified`/`failed`/`unknown`) and `VerificationEvidence` shape | Pattern reused for flow verification (§7) — new module, same honesty discipline, no shared code (the mechanisms are unrelated: Reasoning Engine chat probe vs. Application Integration test-case execution). |
| `HANDOFF_WORKFLOWS.md` (storefuze D365 reference, root of repo) | Cited as the mapping-surface shape reference only — trigger-type split, operationId→GCP table, the ~84-name/339-call `msdyn_*` custom-action set, the Entra token-fetch pattern. Treated as **unverified against this project's real target tenant(s)** and reproduced in `FlowIR`/mapper design below with that caveat attached everywhere it's used. |

## 3. Architecture

### 3.1 The two-phase boundary, extended (not altered)

Flows get their **own** two-phase pipeline, run alongside (not merged into) the existing
agent pipeline:

```
FLOW PHASE 1 EXTRACT+MAP:  Dataverse `workflows` (category eq 5) → FlowIR → FlowMapper
                            (pure transform, no GCP calls) → LOAD into Mongo `stagedFlows`

FLOW PHASE 2 INSERT:       read staged flow rows → create/update the headless GCP
                            execution artifact → verify → report
```

This mirrors the existing agent pipeline's own internal shape: `orchestrator.ts`'s
Phase 1 already does extract-AND-map (mapper.ts runs before staging, producing
`MappedAgent`, not just `AgentIR`) — `stagedAgents` rows already carry `mapped`. The flow
pipeline follows the same precedent: `stagedFlows` rows carry a `MappedFlow` (an
engine-specific deployable payload — see §5 for its current shape), computed with zero
API calls, during Phase 1.

**Boundary rule preserved**: `services/dataverseFlows.ts` (new, extraction-only) never
imports anything from `services/flowDeployer.ts` (new, GCP-write-only) or any existing
`services/gemini*.ts` module. The staging collection (`stagedFlows`) is the only handoff,
exactly as `.claude/rules/architecture-boundaries.md` requires for the agent pipeline.
This also makes a failed flow-insert run retryable without re-extracting/re-parsing
`clientdata` — the same resilience property the agent pipeline gets from `stagedAgents`.

**Why a separate pipeline, not a branch inside the existing one**: flows are
environment-scoped, not agent-scoped 1:1 (one flow can be called by zero, one, or many
agents; `MigrationScope` today is expressed entirely in terms of `AgentRef`/`botIds`).
Forcing flows through `ResolvedPlan`/`ScopeUnit`, which are typed around bots, would
require reshaping a type that many existing call sites depend on. A parallel
`FlowMigrationScope` (`{ kind: 'flows'; env: string; workflowIds: string[] }` /
`{ kind: 'environments'; envs: string[] }`, same shape family as `MigrationScope`) is
cheaper and keeps the existing scope type untouched. **This is a recommended default, not
a mandate** — flag as open if a future UI pass wants one combined wizard step; not
resolved here.

### 3.2 `AgentIR` / DB-schema impact

- **`AgentIR` shape change: NO.** Nothing here modifies `AgentIR`, `AgentToolIR`, or any
  existing field. `AgentToolIR.flowId` (already shipped) is read, not written to.
- **`FlowIR` is a new, additive contract**, not an extension of `AgentIR`. It is a
  first-class IR the same way `AgentIR` is, and per `architecture-boundaries.md` its
  introduction is exactly the kind of decision requiring Architect sign-off — this
  document **is** that sign-off, to be logged in `decisions.md` (§9). The engine
  re-decision in this revision does **not** touch `FlowIR` — it is platform-neutral by
  design and the Application Integration re-decision only changes what `MappedFlow` and
  `flowDeployments` look like (§5, §10). That confirms the IR boundary is holding the way
  it's supposed to: an execution-target swap costs a mapper/deployer rewrite, not an IR
  rewrite.
- **DB schema: additive only.** Four new collections proposed (§10); zero changes to any
  of the 17 collections `db/mongo.ts` already bootstraps. One collection's field shape
  (`flowDeployments`) differs from the original Cloud-Workflows-era draft — see §10.

### 3.3 Data flow diagram

```
                    ┌─────────────────────────────────────────────┐
                    │  FLOW PHASE 1 (extract + map, no GCP calls)  │
Dataverse           │                                               │
`workflows`  ──────►│ dataverseFlows.ts ──► FlowIR ──► flowMapper.ts │──► stagedFlows (Mongo)
category eq 5       │   (parses clientdata,   │           (pure)      │      status: 'staged'
                    │    trigger, actions,     │                       │
                    │    connectionRefs)       │                       │
                    └─────────────────────────────────────────────┘
                                                                              │
                                                                              ▼
                    ┌─────────────────────────────────────────────┐
                    │  FLOW PHASE 2 (insert — GCP writes)          │
   stagedFlows ────►│ flowDeployer.ts:                             │──► flowDeployments (Mongo)
   status='staged'  │  Application Integration:                    │      (idempotency cache,
                    │  - integrations.versions.upload/patch         │       like adkDeployments)
                    │  - triggerConfigs (Schedule/API/Webhook)       │
                    │  - taskConfigs (Connectors/REST/Data Mapping/  │
                    │    loops/Call Integration/Return/Timer)        │
                    │         │                                     │
                    │         ▼                                     │
                    │ verifyFlow.ts (test-case creation + mocked    │──► flowMigrationResults
                    │   execution + binding checks, §7)              │      (Mongo, like
                    └─────────────────────────────────────────────┘      migrationResults)
```

## 4. `FlowIR` — the platform-neutral extraction shape

Unchanged by this revision. Proposed addition to `server/src/types.ts` (or a co-located
`flowTypes.ts` imported by it — implementer's call, no architectural difference).
Field-by-field rationale is inline; every field either preserves something a downstream
execution engine needs, or rides along on `unmapped`/`unsupportedActions` per this
project's lossless rule.

```ts
export type FlowTriggerKind = 'recurrence' | 'request' | 'webhook' | 'unknown';

export interface RecurrenceTriggerIR {
  kind: 'recurrence';
  frequency: string;        // PA's Frequency enum verbatim (Second|Minute|Hour|Day|Week|Month|Year)
  interval: number;
  timeZone?: string;
  startTime?: string;       // ISO, when the flow pins a start
  raw: unknown;             // the trigger's authored JSON, verbatim — lossless fallback
}

export interface RequestTriggerIR {
  kind: 'request';
  method?: string;
  schema?: unknown;         // inbound JSON schema, verbatim
  raw: unknown;
}

export interface WebhookTriggerIR {
  kind: 'webhook';
  connectorId?: string;         // e.g. shared_commondataserviceforapps
  entityLogicalName?: string;   // Dataverse table watched, e.g. msdyn_evaluation
  messageType?: string;         // Create|Update|Delete|none, verbatim from the payload
  raw: unknown;
}

export interface UnknownTriggerIR { kind: 'unknown'; raw: unknown; }

export type FlowTriggerIR = RecurrenceTriggerIR | RequestTriggerIR | WebhookTriggerIR | UnknownTriggerIR;

/**
 * One step in the flow's action graph. PA's own JSON is itself a graph (runAfter-keyed),
 * not a flat list — FlowActionIR preserves that shape rather than flattening it, so a
 * mapper can honor branching/sequencing instead of guessing an order.
 */
export interface FlowActionIR {
  id: string;                  // the action's key in the source JSON (stable, authored)
  actionType: string;          // raw PA type name: OpenApiConnection, If, Foreach, Scope, ...
  operationId?: string;        // e.g. ListRecords, PerformUnboundAction, ExecuteCopilotAsyncV2
  connectorId?: string;        // resolved connection-reference id for this step
  entityLogicalName?: string;  // Dataverse table, for CRUD-shaped operations
  /** True for msdyn_* PerformUnboundAction/PerformBoundAction calls — Microsoft-proprietary,
   *  no GCP equivalent. Kept as a raw Dataverse REST call at runtime, never translated. */
  isCustomDataverseAction?: boolean;
  customActionName?: string;   // the msdyn_ActionName itself, when isCustomDataverseAction
  /** For ExecuteCopilotAsyncV2 / ExecuteDataverseCopilotToStart / ContinueExecuteDataverseCopilot:
   *  the Copilot agent this action targets. UNCONFIRMED which authored field actually carries
   *  this on a real tenant (HANDOFF_WORKFLOWS.md documents the operationIds but not this field) —
   *  extraction reads whatever the payload names as best-effort and reports it as such; do not
   *  assume this is always populated. See §9, open question #1. */
  calledAgentSourceId?: string;
  inputsRaw?: unknown;         // authored parameters, verbatim — the lossless fallback per step
  runAfter?: string[];         // predecessor action ids + their expected statuses (PA's own graph)
  children?: FlowActionIR[];   // nested actions for Scope/If/Foreach/Until/Switch branches
}

export interface FlowConnectionRefIR {
  referenceLogicalName: string;  // connection reference schema name
  connectorId: string;           // e.g. shared_commondataserviceforapps, shared_teams
  displayName?: string;
}

export interface FlowIR {
  sourceId: string;              // Dataverse workflowid (GUID) — the stable id, and the join
                                  // key AgentToolIR.flowId points at
  name: string;
  envUrl: string;
  trigger: FlowTriggerIR;
  actions: FlowActionIR[];       // top-level graph; branches nest via .children
  connectionReferences: FlowConnectionRefIR[];
  /** Verbatim clientdata JSON, unparsed. The true lossless fallback: whatever the structured
   *  fields above miss or get wrong, this still has it. Never dropped to keep the IR "clean". */
  rawClientData: string;
  /** Copilot agent botids this flow calls (derived from actions[].calledAgentSourceId).
   *  Flattened here for cheap querying/joining against AgentIR without walking the action graph. */
  callsAgentSourceIds: string[];
  /** msdyn_*-style or otherwise GCP-unmappable actions, named honestly — never silently
   *  translated into something that changes behavior. Surfaces directly as FidelityNotes. */
  unsupportedActions: { actionId: string; actionType: string; reason: string }[];
  /** Anything else extracted but not yet structured (mirrors AgentIR.unmapped). */
  unmapped: string[];
  sourceMetadata?: {
    createdOn?: string;
    modifiedOn?: string;
    isManaged?: boolean;
    ownerId?: string;
    /** Dataverse statecode — an authored-but-disabled flow (0=Draft/1=Activated per PA's own
     *  convention) should not be deployed as a live trigger by default, mirroring
     *  AgentIR.sourceMetadata.lastPublished's draft-gating precedent. */
    enabled?: boolean;
  };
}
```

**Design notes on the shape:**

- `FlowActionIR` is a **graph**, not a flat array, because Power Automate's own JSON is a
  graph (`runAfter` keys reference predecessor action names, `If`/`Foreach`/`Scope`
  nest children). Flattening at extraction time would silently discard control flow the
  mapper needs — this is exactly the kind of information the lossless rule protects.
- `isCustomDataverseAction`/`customActionName` on `FlowActionIR`, plus the top-level
  `unsupportedActions`, are two views of the same fact for two different consumers: the
  mapper needs the per-step flag to decide "keep as raw Dataverse REST call"; the report
  needs the flat list to render an honest fidelity summary without walking the graph.
- `calledAgentSourceId` is the **reverse** direction of the `AgentToolIR.flowId` link
  (agent → flow). Together they make the relationship bidirectional and queryable without
  a third join table: "which flows does this agent call" reads `AgentIR.agentTools`;
  "which agents does this flow call" reads `FlowIR.callsAgentSourceIds`. No new join
  mechanism invented — this is `parseFlowId()`'s existing join key, used symmetrically.

## 5. Mapping: `FlowIR` → GCP (revised — Application Integration, not Cloud Workflows)

**This section supersedes the original Cloud Workflows YAML-generation design.** New pure
module `services/flowMapper.ts` (Phase 1, no API calls — same discipline as `mapper.ts`),
producing:

```ts
export interface MappedFlow {
  ir: FlowIR;
  displayName: string;
  /** The full IntegrationVersion JSON body for
   *  projects.locations.integrations.versions.upload/.patch — triggerConfigs[] + taskConfigs[]. */
  integrationVersion: unknown;      // typed as the IntegrationVersion shape once confirmed live
  triggerKind: 'schedule' | 'api' | 'webhook';
  schedule?: { cron: string; timeZone: string };  // recurrence only — native Schedule trigger
  entraCredentialRef: { tenantId: string; secretId: string }; // which entraAppCredentials row backs this flow's runtime Dataverse calls
  /** Per-task mock plan for verification (§7) — built alongside the integration, not
   *  bolted on afterward, since which tasks are safe to leave unmocked vs. must be
   *  Mock-Output'd is a mapping-time fact (does this task write to Dataverse / call an
   *  msdyn_* action / call the Interactions API), not a verification-time guess. */
  testCasePlan: { taskId: string; mockStrategy: 'none' | 'mock-output'; mockValue?: unknown }[];
  fidelityNotes: FidelityNote[];      // same FidelityNote type AgentIR mapping already uses
}
```

**Why Application Integration replaces the Cloud Workflows + Cloud Scheduler + Cloud
Run/Eventarc combination**: a researcher pass (2026-09-03, see `decisions.md`) confirmed
Application Integration is a single GCP product that natively covers what the original
design had to glue together from three separate ones — native trigger types instead of
Scheduler-triggers-a-Workflow / Eventarc-triggers-a-Workflow-via-Cloud-Run, and native
loop/branch/return/timer/sub-flow-call task types instead of hand-generated YAML control
structures. It does **not** meaningfully change the msdyn_* story (§8 #1, still a plain
REST task + manual Entra token either way) and its one clear-cut new capability — a
pre-built Dataverse connector for CRUD — has a genuinely unconfirmed auth-model fit
(§6.2, §9 #8) that this design does **not** assume works. The deciding factor is §7:
Application Integration ships a real, confirmed test-case/mocking framework that directly
answers this document's previously-open, blocking verification question (§9 #3 in the
prior revision) — Cloud Workflows had no equivalent and this document's own prior
revision flagged that as unresolved design debt. See §12 for the full head-to-head and
the explicit decision.

Trigger-keyed routing (three branches, same three trigger kinds `FlowIR` already
captures):

| Trigger | Application Integration target | Mapper output |
|---|---|---|
| `recurrence` | native **Schedule trigger** (unix-cron) on the Integration | `schedule.cron`/`timeZone` derived from `frequency`/`interval`; falls back to a **Cloud Scheduler trigger** only if the native Schedule trigger's cron semantics can't represent PA's `Frequency`/`interval` model exactly (implementer decision at mapping time, not blocking — flag with a `FidelityNote(status: 'mapped')` either way, naming which trigger flavor was used) |
| `request` | **API trigger** (`integrations.execute`, sync or async — mapper picks async by default unless the source `Request` trigger's response shape implies the caller waits synchronously) | `triggerKind: 'api'` |
| `webhook` (`OpenApiConnectionWebhook`) | **Webhook trigger** or **Connector Event trigger** (dynamic public callback URL) | `triggerKind: 'webhook'`, `entityLogicalName` carried through for the (out-of-scope-here) Dataverse-plugin/webhook-registration step |

Per-action mapping inside `integrationVersion.taskConfigs` generation (reference table,
cites `HANDOFF_WORKFLOWS.md` §7–9 as a **starting** map, not a verified one):

- Dataverse CRUD (`ListRecords`, `CreateRecord`, `UpdateRecord`, `UpdateOnlyRecord`,
  `DeleteRecord`, `GetItem`, `GetRelevantRows`) → a **Connectors task** against the
  pre-built Dataverse connector (`List`/`Get`/`Create`/`Update`/`Delete`/
  `ListAssociations`/`ListNavigationProperties`), **conditional on §9 #8 being confirmed**
  (the connector's generic-OAuth2 auth profile supporting Entra app-only
  `client_credentials`). Until that's confirmed against a live tenant, `flowMapper.ts`
  emits the **same REST-task fallback the prior Cloud-Workflows-era design already
  specified** — a plain HTTP task against `{org_url}/api/data/v9.2/{entity}`,
  bearer-authenticated via the Entra token task (§6.2), unchanged. This means the
  Application Integration re-decision costs nothing if the connector auth turns out not
  to fit: the fallback is a strict subset of work this design already had to do anyway.
- Control flow: `If`→edge conditions on the task graph (no dedicated multi-branch task —
  `Switch` source actions map to a chain of conditional edges, a real but minor fidelity
  narrowing vs. Cloud Workflows' native `switch` step, noted as `FidelityNote(status:
  'mapped')` with the detail spelled out); `Foreach`→**For Each Loop** task (native);
  `Until`→**While Loop** task (native); `Scope`→flattened group, **no confirmed direct
  equivalent** (same gap the prior Cloud Workflows design also had — not solved by the
  engine swap); `Terminate`/`Response`→**Return** task (native); `ParseJson` is a no-op
  (task outputs are already structured).
- Variables (`SetVariable`, `InitializeVariable`, `Compose`, `Append*Variable`,
  `IncrementVariable`, `Select`) → **Data Mapping** task (a clean native fit — Application
  Integration's Data Mapping task is purpose-built for exactly this class of operation,
  arguably a better native match than Cloud Workflows' generic `assign` step).
- `Wait` → **Timer** task (native).
- `Workflow` (calls another PA flow) → **Call Integration** task — a first-class task
  type, joined via that sub-flow's own `FlowIR.sourceId` if it was migrated in the same
  run; **needs a `FidelityNote(status: 'needs-review')`** when the referenced sub-flow was
  NOT part of the same migration scope (cannot resolve the call target). This is a
  materially better fit than the prior design's hand-rolled "call another Cloud Workflow"
  block — no change to the underlying fidelity logic, just a cleaner native primitive.
- `msdyn_*` custom actions (`isCustomDataverseAction: true`) → a plain **REST task**
  (`POST {org_url}/api/data/v9.2/{entity}/Microsoft.Dynamics.CRM.{action}`) with the Entra
  bearer token from the same token-fetch task used for the CRUD fallback above — **not
  translated, and not improved by this engine choice**, because Application Integration's
  Dataverse connector does not cover `PerformUnboundAction`/`PerformBoundAction` (confirmed
  by the researcher pass — this is the single largest operationId bucket in
  `HANDOFF_WORKFLOWS.md`, and neither engine option has a native answer for it). Fidelity
  note: `status: 'partial'` ("preserved as a live Dataverse REST call; the migrated flow
  still depends on the source Dataverse environment staying reachable and this Entra app
  registration staying valid — not a native GCP capability, and this is true regardless of
  execution engine").
- `ExecuteCopilotAsyncV2` / `ExecuteDataverseCopilotToStart` / `ContinueExecuteDataverseCopilot`
  → a **REST task** calling the Gemini Enterprise **Interactions API**, targeting the
  migrated Gemini agent resolved from `calledAgentSourceId`. **This does not differentiate
  the two engine options** — a REST task calling the Interactions API is exactly as
  straightforward as the prior design's `http.post` step; noted explicitly so this isn't
  miscounted as an Application Integration advantage. Still **gated by the ADK-invocation
  constraint (§9, confirmed live 2026-08-24)**: if the target agent's most recent
  `MigrationResult`/`adkDeployments` record shows it was migrated low-code (not ADK), this
  step CANNOT be aimed correctly — `:assist` 404s and `:streamAssist` ignores the agent id,
  answering with the engine default. The mapper must emit `FidelityNote(status: 'lost',
  detail: 'calls Copilot agent "<name>" via ExecuteCopilotAsyncV2; that agent was migrated
  low-code, which has no per-agent invocation API — this call cannot be aimed at it on
  Gemini and must not silently call whichever agent the engine defaults to; redeploy
  "<name>" as ADK to restore this call')` rather than emit a call that looks like it
  targets one agent but doesn't. When the target agent isn't in the same customer's
  migrated set at all, note `needs-review` with "target agent not found in this
  migration's results — resolve manually."
- `HtmlToText` → inline string-strip logic inside a **Data Mapping** task (no dedicated
  GCP service; simple enough to reproduce directly) — `FidelityNote(status: 'mapped')`.
- `PostCardAndWaitForResponse` / `PostCardToConversation` (Teams) → **no direct Google
  Chat equivalent has been verified by this project**, on either engine (the HANDOFF doc's
  "swap for Google Chat API" is an unverified suggestion from a different tenant's
  research, not confirmed against this project's target). `FidelityNote(status:
  'needs-review', detail: "Teams card interaction — no confirmed Google Chat equivalent;
  preserved as unmapped, needs a Researcher pass before this can be a real 'mapped'
  claim")`. Do not implement a guessed Google Chat call without that confirmation — this is
  exactly the kind of unverified external-behavior claim
  `.claude/skills/architecture/SKILL.md`'s fidelity-honesty rule exists to catch.

## 6. Identity model

### 6.1 Headless service identity (GCP-side), distinct from ADK per-user impersonation — revised

Application Integration provisions exactly **one default, project-scoped runtime service
account** per project — `service-PROJECT_NUMBER@gcp-sa-integrations.iam.gserviceaccount.com`
— confirmed by the researcher pass. This directly **resolves** open question #4 from the
prior revision ("one shared runtime SA per customer project vs. one per deployed flow"):
the platform itself only supports project-level granularity, so per-flow runtime identity
is not a choice this design gets to make either way. `roles/secretmanager.secretAccessor`
is granted to this SA on exactly the secrets `grantSecretAccessToServiceAgent` already
grants per-secret — same reuse pattern ADK's Reasoning Engine runtime SA and the prior
Cloud Workflows draft both used, just pointed at a different SA principal. Four APIs need
enabling per customer project: `integrations.googleapis.com`,
`secretmanager.googleapis.com`, `connectors.googleapis.com` (only needed if/when the
Dataverse connector is actually used — §9 #8), `cloudkms.googleapis.com`. This is
confirmed structurally equivalent to Cloud Workflows' own per-project provisioning model
(§9 #4 in the prior revision flagged this as needing a `/cso`-style security pass before
choosing granularity — that pass is now moot, since the platform doesn't offer a
finer-grained option to choose between).

This remains **structurally unrelated** to the ADK `_bind_caller`/`user_id` impersonation
mechanism, which only exists inside an ADK Reasoning Engine runtime bound to a signed-in
end user's own OAuth session. A headless Application Integration execution has no
"signed-in user" by definition — there is no caller to bind. This was accepted explicitly
in the 2026-09-03 headless-vs-agent-tool decision and is not re-opened here; it is simply
named at the exact point where an implementer would otherwise be tempted to reach for
`_bind_caller` and find it doesn't apply.

### 6.2 Microsoft-side identity: Entra app-only, reused unchanged — one new unconfirmed item

For calls back into Dataverse/MS Graph (the CRUD ops, the `msdyn_*` custom actions), the
deployed flow uses the **exact same app-only `client_credentials` pattern** Phase-1
extraction already uses (`auth/microsoft.ts`) — never a delegated/per-user token, and
never the ADK impersonation model. Concretely: the flow's first task fetches a token from
`login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token` with
`grant_type=client_credentials` (the exact pattern `HANDOFF_WORKFLOWS.md` §11 documents
and this codebase already runs today for extraction) using `client_id`/`client_secret`
read from Secret Manager at execution time via `entraAppCredentials`
(`services/secretManager.ts`'s `getEntraSecret`, unchanged). This is the pattern used by
the REST-task fallback for every Dataverse call (CRUD included, until §9 #8 is confirmed,
and `msdyn_*` custom actions always) — identical to the prior Cloud Workflows design, not
affected by the engine re-decision.

**New, genuinely unconfirmed item introduced by this revision (§9 #8)**: whether
Application Integration's pre-built Dataverse connector's auth profile — generic OAuth2
(client ID/secret/authorization URL/scope) — actually supports Entra app-only
`client_credentials`, the auth model this whole project already uses everywhere else. This
is **not assumed to work**. If it does, the Dataverse connector becomes a real,
lower-code-surface alternative to the REST-task fallback for CRUD ops specifically; if it
doesn't, `flowMapper.ts` uses the REST-task fallback for CRUD too, and the practical
mapping surface reduces to "same as the prior Cloud Workflows design, plus native
loops/branches/sub-flow-calls/verification" — still a net improvement, just a smaller one.
**Separately confirmed, a real caveat regardless of the auth answer**: exported/imported
`IntegrationVersion` JSON does **not** round-trip connector authentication profiles — they
must be reconfigured after import, which is in tension with this project's "no console
click" programmatic-creation model for the connector path specifically (the REST-task
fallback has no such gap, since it fetches its own token at runtime from Secret Manager
and never depends on a persisted connector auth profile).

**Deliberate, accepted gap — surfaced honestly, not hidden, unchanged from the prior
revision**: because this is one shared app-only identity, a migrated flow's Dataverse
reads/writes run under the SAME Dataverse permissions regardless of which human originally
triggered the source Power Automate flow. Every migrated flow gets a standing
`FidelityNote(component: 'identity-model', status: 'needs-review', detail: 'this flow now
runs under a single shared service identity for its Dataverse/Graph calls; it does not act
as whichever user or Copilot Studio session originally triggered it')` — always emitted,
never conditionally.

**Open question, not resolved here (§9 #5, carried forward unchanged)**: whether one Entra
app registration (the one already provisioned for extraction) has sufficient Dataverse
scope for the `msdyn_*` write actions flows perform at runtime, or whether a second,
more-privileged app registration is needed. Confirm against a real customer tenant before
assuming reuse is sufficient — do not silently widen the extraction app's scope to cover
this without the customer admin's explicit awareness (`security-rules.md`: minimum
scopes).

## 7. Verification — revised: test-case mocking replaces the unresolved `dryRun` approach

The prior revision of this document left verification as an **open, blocking design
question** (§9 #3 in that revision: "does the mapped Cloud Workflows YAML need a
hand-rolled `dryRun` input for safe synthetic verification" — unresolved, no native
mechanism existed to answer it). Application Integration removes that gap with a real,
documented mechanism: `versions.testCases.create` / `.execute` / `.executeTest`, with
**per-task mock strategies** — "No mock" (task runs for real), "Mock execution"
(succeed/fail without running), "Mock Output" (return a specified canned value) — plus
assertions on task status/inputs/outputs. `services/verify.ts` still cannot reach this
surface (it is built entirely around Discovery Engine agent probing); new module
`services/verifyFlow.ts`, same fidelity discipline (three-state truth:
`verified`/`failed`/`unknown`, never a bare boolean), same `FidelityNote`-producing
contract:

1. **Workflow-logic check (all three trigger types)** — for every deployed integration
   version, create ONE test case using the `testCasePlan` the mapper already computed
   (§5): every task that would write to Dataverse, call an `msdyn_*` custom action, or
   call the Gemini Interactions API is set to `Mock Output` with a safe canned response;
   every pure-logic/control-flow task (Data Mapping, For Each Loop, While Loop, Return,
   Timer, conditional edges) runs unmocked, so the graph's actual branching/looping logic
   is genuinely exercised. Execute via `versions.testCases.execute`, poll for completion,
   assert the expected task-status/output shape. This directly replaces the prior design's
   unresolved hand-rolled `dryRun` input — no bespoke input field needs to be threaded
   through every generated integration, because mocking is a first-class platform
   mechanism, not something this project has to invent.
2. **Trigger binding check (all three trigger types)** — confirm the deployed trigger
   (Schedule/API/Webhook/Connector Event) exists, is active, and its config (cron string,
   entity/message type for webhook/connector-event triggers) matches what the mapper
   emitted. Config-match, not an early real-world fire — same "describe what's checkable"
   precedent `verify.ts` itself established (its `:streamAssist` finding is the
   cautionary tale this design continues to avoid repeating).
3. **Connector/REST-task auth check** — for flows using the Dataverse connector (only once
   §9 #8 is confirmed and the connector path is actually in use) or the REST-task
   fallback, confirm the referenced Secret Manager secret is reachable
   (`preflightSecretAccess`, reused) without actually invoking Dataverse. This mirrors the
   prior design's identical intent but is now explicit as its own numbered check since
   the mocked test-case run in #1 already covers "does the graph execute," leaving "is the
   credential wiring even reachable" as a separate, cheaper, always-safe check.

**New, genuinely unconfirmed item introduced by this revision (§9 #9)**: whether mocking a
task (`Mock Output`/`Mock execution`) fully prevents any real outbound network/auth call
before the mock short-circuits it, or whether some task types still perform a real
connection attempt before substituting the mocked result. This is **not assumed safe**.
Before `verifyFlow.ts` is trusted to run test cases against real customer Dataverse
environments without side effects, this needs a `_diag_*` probe against a live tenant
(mock a `Create` task against a disposable/test Dataverse record, confirm via Dataverse's
own audit log or a before/after row-count check that nothing was actually written) — not
inferred from Google's product description alone.

Every check reports `unknown` (not `failed`) when the check itself could not run (e.g.
insufficient IAM to read the test-case result) — matching `verify.ts`'s own "a failure
names a defect, an unknown names a check somebody still has to do by hand" principle
verbatim. Results land on a new `FlowVerificationEvidence` shape (parallel to, not
reusing, `VerificationEvidence` — the two mechanisms don't share fields) attached to
`flowMigrationResults` rows (§10).

## 8. Fidelity / honesty — explicit loss surfaces

Unchanged in substance from the prior revision; wording updated where the engine swap
changes *how* something is preserved but not *whether* it's lost. Every one of these MUST
produce an explicit `FidelityNote` (`lost`, `partial`, or `needs-review`), never a silent
drop and never an overclaimed `mapped`:

1. The `msdyn_*` custom actions (~84 distinct actions, 339 call sites per
   `HANDOFF_WORKFLOWS.md`'s operationId accounting — the single largest action bucket) —
   `partial`, not `lost` (they still work, via raw Dataverse REST + Entra token, on either
   engine) — but explicitly named as "not a native GCP capability, still depends on the
   source Dataverse environment," and explicitly **not improved by the Application
   Integration engine choice** — this is stated honestly in §5 rather than let the engine
   swap be read as having solved it.
2. `ExecuteCopilotAsyncV2`/family calls targeting a low-code-migrated (non-ADK) agent —
   `lost`, per the confirmed platform constraint (`verify.ts:325-357`, live-tested
   2026-08-24: Discovery Engine's `:assist` 404s, `:streamAssist` ignores `agentsConfig.agent`).
   Engine-independent.
3. Teams card interactions (`PostCardAndWaitForResponse`/`PostCardToConversation`) —
   `needs-review`, no confirmed Google Chat equivalent yet (unverified suggestion from a
   different tenant's research only). Engine-independent.
4. Sub-flow (`Workflow` action type) references to a flow not included in the same
   migration scope — `needs-review`, cannot resolve the call target. Engine-independent
   (Call Integration task vs. hand-rolled Cloud Workflow call — same failure mode either
   way).
5. The identity-model note (§6.2) — `needs-review`, unconditionally, on every migrated
   flow. Engine-independent.
6. `If`/`Switch` source actions mapping to Application Integration's edge-condition model
   instead of a dedicated multi-branch Switch task — `mapped`, with detail noting the
   representational difference (new item introduced by the engine re-decision — the prior
   Cloud Workflows design had a native `switch` step and did not need this note).
7. `Scope` — no confirmed direct equivalent on either engine; flattening fallback,
   `needs-review`. Engine-independent (was already true of the prior design).
8. Anything landing in `FlowIR.unmapped` or `unsupportedActions` with no specific handling
   above — `needs-review` by default; never silently coerced into `mapped`.

## 9. Open questions requiring further sign-off before implementation

Numbered for reference from the sections above. Items #1, #2, #5, #6, #7 are carried
forward unchanged from the prior revision. Item #3 (`dryRun`) is superseded by §7's
test-case mocking approach — kept below, marked superseded, for the historical trail.
Item #4 (shared vs. per-flow runtime SA) is resolved by §6.1's platform-constraint finding
— kept below, marked resolved. Items #8 and #9 are new, introduced by this revision.

1. **Which field actually carries the target Copilot agent id on
   `ExecuteCopilotAsyncV2`/`ExecuteDataverseCopilotToStart`/`ContinueExecuteDataverseCopilot`
   actions, confirmed against a real tenant** — `HANDOFF_WORKFLOWS.md` documents the
   operationIds but not this field; `calledAgentSourceId` extraction is best-effort until
   a Researcher pass confirms it live. Do not treat extraction of this field as
   proven — degrade to `unmapped`/`needs-review` when absent, never guess.
2. **The `:assist`/`:streamAssist` low-code invocation gap** (already confirmed, cited
   throughout) — carried forward as a hard constraint on this design, not re-verified
   here; no new work needed, just don't build around it as if it didn't exist.
3. **SUPERSEDED by §7 (this revision)**: "whether the mapped `workflowYaml` supports a
   `dryRun` input for safe synthetic verification" — this was Cloud-Workflows-specific and
   no longer applies now that Application Integration's test-case mocking is the chosen
   verification mechanism. Kept here, marked superseded, so the design trail is legible;
   do not resurrect a `dryRun`-input requirement without re-opening this question.
4. **RESOLVED by §6.1 (this revision)**: "one shared GCP runtime service account per
   customer project vs. one per deployed flow" — Application Integration only provisions
   one default per-project SA; the platform itself removes the choice. No `/cso` pass
   needed on this specific question as a result (a `/cso` pass on the overall design is
   still good practice before implementation, just not gated on this question anymore).
5. **Whether the existing extraction Entra app registration has sufficient Dataverse
   scope for `msdyn_*` write actions at flow-runtime**, or a second app registration is
   needed (§6.2) — needs live-tenant confirmation, not an assumption. Unchanged by this
   revision.
6. **The four unexplained `workflowMigrations`/`workflowFlows`/`workflowAttempts`/
   `workflowGcpTokens` Mongo collections** — NOT adopted by this design (§10 lists fresh
   collection names instead). Before anyone considers reusing them: identify who created
   them and confirm they're not a different, unrelated project sharing the same Mongo
   host. Treat as unrelated until proven otherwise.
7. **Where this surfaces in the wizard UI / whether it's one combined flow with agent
   migration or a separate step** — explicitly out of scope for this Architect pass;
   flag for a product/UX decision, not assumed.
8. **NEW (this revision): does Application Integration's pre-built Dataverse connector's
   generic-OAuth2 auth profile support Entra app-only `client_credentials`** — genuinely
   unconfirmed (§6.2, §5). Needs live-tenant confirmation before `flowMapper.ts` is allowed
   to prefer the Connectors task over the REST-task fallback for Dataverse CRUD. Until
   confirmed, the mapper MUST default to the REST-task fallback for CRUD (identical to the
   msdyn_* pattern) — do not guess this works.
9. **NEW (this revision): does mocking a task in an Application Integration test case
   (`Mock Output`/`Mock execution`) fully prevent any real outbound network/auth call
   before the mock substitutes its result** — genuinely unconfirmed (§7). Needs a
   `_diag_*` probe against a live tenant before `verifyFlow.ts`'s mocked test-case
   execution is trusted as safe-by-default against real customer Dataverse environments.

**Safe to start implementing directly, once #1 is resolved** (does not require further
sign-off — additive, boundary-respecting, follows existing conventions exactly): the
`FlowIR`/`FlowActionIR`/`MappedFlow` type additions, `services/dataverseFlows.ts`, the four
new repo modules (§10), and idempotent bootstrap entries in `db/mongo.ts`. **`flowMapper.ts`
and `flowDeployer.ts` additionally need #8 addressed (even if the answer is "unconfirmed,
default to REST-task fallback," which is itself a safe, buildable default) and #9 addressed
before `verifyFlow.ts`'s mocked-execution path is used against a real customer tenant.**

## 10. New DB collections (additive; nothing existing changes) — `flowDeployments` shape revised

All four follow the existing one-repo-per-collection convention
(`db/repos/<name>.ts`), all `appUserId`-scoped, all best-effort (`isDbConnected()` guard,
never throw), all bootstrapped idempotently in `db/mongo.ts` alongside the existing 17:

1. **`stagedFlows`** — mirrors `stagedAgents` exactly in spirit: one row per flow per
   run, `status: 'staged' | 'inserted' | 'failed' | 'skipped'`, carries `ir: FlowIR` and
   `mapped: MappedFlow` (now the Application-Integration-shaped `MappedFlow` from §5).
   Index: `{runId, sourceId}` unique (matches `stagedAgents`'s pattern); `{appUserId,
   runId, status}` for tenant-scoped reads (same read-path scoping rule `stagedAgents`
   already documents and enforces via a required `appUserId` parameter on its list
   function — `listStaged`'s pattern should be copied verbatim for `listStagedFlows`).
   Unaffected in shape by the engine re-decision beyond `MappedFlow`'s own content.
2. **`flowIRCache`** — mirrors `agentIRCache`: `{appUserId, envUrl, sourceId}` unique,
   holds the extracted `FlowIR` + `MappedFlow` for audit/re-run-without-re-extracting.
   Unaffected by the engine re-decision.
3. **`flowDeployments`** — mirrors `adkDeployments` in *purpose* (idempotent GCP-resource
   tracking so a re-run reuses/updates existing resources instead of creating duplicates),
   but its **field shape changes** with this revision:
   - `{appUserId, envUrl, sourceId, project}` unique — unchanged key shape.
   - **Replaces** the prior draft's `{cloudWorkflowName, schedulerJobName,
     cloudRunServiceName, eventarcTriggerName}` fields with Application Integration
     resource identifiers: `integrationName` (the `Integration` resource path,
     `projects/{p}/locations/{l}/integrations/{name}`), `integrationVersionId` (the
     deployed/active version — Application Integration versions each deploy discretely,
     unlike a Cloud Workflow's single mutable "current" revision, so this field has no
     direct predecessor in the prior draft), `triggerIds: string[]` (from the deployed
     version's `triggerConfigs`), and, only when the mapper fell back to a Cloud Scheduler
     trigger flavor rather than the native Schedule trigger (§5's routing table),
     `schedulerJobName` — kept as an optional field for that one fallback case, not
     removed outright.
   - **New field**: `testCaseId` (§7) — the Application Integration test case resource
     created for this flow's mocked verification run, tracked here so `verifyFlow.ts`
     reuses/updates the existing test case on re-verification instead of creating a
     duplicate every run, matching the same idempotency discipline the rest of this field
     already follows.
4. **`flowMigrationResults`** — mirrors `migrationResults`: one row per flow per run,
   `{runId, sourceId}` unique, shape parallels `MigrationResult` (`created`, `deployed`,
   `verified`/`verifyStatus`/`verifyEvidence` using the new `FlowVerificationEvidence`
   shape from §7, `fidelity: FidelityNote[]`, `error?`). Unaffected in shape by the engine
   re-decision beyond `FlowVerificationEvidence`'s own content (§7).

No existing collection's schema changes. `db/mongo.ts`'s "All N collections verified"
log line and comment numbering get updated additively when implemented.

## 11. Implementation sequence (hand-off-ready) — revised for Application Integration

1. Resolve open question #1 (§9) — a short Researcher/live-tenant pass; blocks step 5
   below specifically, not the earlier ones. Resolve #8 and #9 (§9) before step 7 (the
   deployer) prefers the Connectors task over the REST-task fallback, and before step 8
   (the verifier) is trusted against a real customer tenant, respectively — both can be
   built with safe defaults (REST-task fallback; do-not-trust-mocking-yet) in the
   meantime, so they do not block starting implementation, only trusting certain code
   paths in production.
2. Add `FlowIR`/`FlowTriggerIR` variants/`FlowActionIR`/`FlowConnectionRefIR`/`MappedFlow`
   types (§4–5) to `types.ts` (or a new `flowTypes.ts` re-exported from it) — additive,
   no existing type touched. `npm run typecheck` stays green trivially (nothing else
   references these yet).
3. Add the four repo modules (§10) + idempotent bootstrap entries in `db/mongo.ts`.
   Zero risk to existing collections — additive `ensure()` calls only.
4. Build `services/dataverseFlows.ts` — Phase 1 EXTRACT only. Query `workflows` with
   `category eq 5`, parse `clientdata` into `FlowIR` per §4 (trigger detection first,
   then the action graph, then connection references), degrade unparseable fragments
   into `unmapped`/`unsupportedActions` rather than throwing. Never imports anything
   from `flowDeployer.ts`/`gemini*.ts`/`adkDeployer.ts`.
5. Build `services/flowMapper.ts` — pure `FlowIR → MappedFlow` transform per §5's
   per-action-type table (Application Integration `taskConfigs`/`triggerConfigs`
   generation, defaulting Dataverse CRUD to the REST-task fallback until §9 #8 is
   confirmed), emitting `FidelityNote`s per §8 and the `testCasePlan` per §7. No API
   calls. Unit-testable with vitest exactly like `mapper.ts`/`topicCompiler.ts` (per
   `.claude/rules/testing-standard.md`'s "unit-test the pure transforms first" guidance) —
   this is the highest-value test target in the whole design, since it's pure and has
   the most surface area (all the operationId/action-type branches).
6. Wire Phase 1 into `stagedFlows` (extract → map → `stageFlow()`), following
   `stageAgent()`'s exact pattern in `db/repos/staged.ts`.
7. Build `services/flowDeployer.ts` — Phase 2 INSERT. `integrations.versions.upload`/
   `.patch`, trigger activation, and — only once §9 #8 is confirmed and the mapper starts
   emitting Connectors-task-based `MappedFlow`s — connector auth-profile provisioning
   (noting the export/import round-trip gap from §6.2: a fresh auth profile must be
   created via API on each deploy, not assumed to survive re-import). Idempotent via
   `flowDeployments`. Reuses `secretManager.ts`'s `preflightSecretAccess`/
   `grantSecretAccessToServiceAgent` before deploy, matching the agent pipeline's
   "preflight before deploy" pattern.
8. Build `services/verifyFlow.ts` per §7's mocked-test-case-execution plus trigger-binding
   checks, writing `flowMigrationResults`. Gate the mocked-execution path behind §9 #9
   being confirmed safe against a live tenant; until then, run only the config-match
   trigger-binding check and report `unknown` for the execution-logic check rather than
   assume mocking is side-effect-free.
9. Build `services/flowReport.ts` (or extend `report.ts` with a flow-aware branch —
   implementer's call; recommend a separate module first, given the different result
   shape) for the per-flow fidelity report, reusing the same `FidelityNote` rendering
   conventions as the agent report.
10. Wire a new orchestrator entry point (`runFlowMigration()`, parallel to
    `runMigration()`, not a modification of it) and a new `routes/flows.ts` router
    (mounted `/api/flows`, same SSE/session conventions as `routes/migrate.ts` per
    `api-conventions.md`). UI wizard placement is explicitly deferred (§9 #7).
11. Log the `FlowIR` shape decision and this engine re-decision in
    `.claude/memory/decisions.md` once this design is accepted (see §12) — required by
    `architecture-boundaries.md`'s "changing the IR shape... requires Architect sign-off +
    a note in decisions.md," now satisfied by this document plus the corresponding log
    entries (the original 2026-09-03 headless-vs-agent-tool entry, and the new
    2026-09-03 engine-re-decision entry this revision adds).

## 12. Decision to record

This document (original pass) constituted the Architect sign-off for introducing `FlowIR`
as a new, additive, platform-neutral IR alongside `AgentIR`. **This revision** additionally
constitutes the Architect's recommendation — **not yet the user's approval** — to build the
headless execution layer on **Google Cloud Application Integration** instead of the
originally-designed Cloud Workflows + Cloud Scheduler + Cloud Run/Eventarc combination.

**Head-to-head summary** (full detail in §5–§10 above):

| Dimension | Cloud Workflows + Scheduler + Run | Application Integration |
|---|---|---|
| Trigger coverage | Full, but glued from 3 separate GCP products (Scheduler, Cloud Run, Eventarc) | Full, natively (Schedule/API/Webhook/Connector Event triggers on one product) |
| Control flow (branch/loop/var) | Hand-generated YAML; native `switch`/`for` shapes | Native For Each Loop/While Loop/Data Mapping tasks; edge-conditions instead of a dedicated Switch task (minor narrowing) |
| Dataverse/MS connectivity | Manual REST + Entra token step (fully confirmed pattern, already used by this project) | Pre-built Dataverse connector for CRUD, **auth model unconfirmed** — falls back to the identical manual REST+token pattern if unconfirmed |
| `msdyn_*` (339 calls, largest bucket) | REST task + manual token — no native coverage | Identical — no native coverage either. **Neither engine helps here; be honest about it.** |
| Sub-flow calls | Hand-rolled call-another-Workflow block | Native **Call Integration** task — real improvement |
| Verification/testability | **Unresolved open question** — no native mechanism, would need a hand-rolled `dryRun` input | **Confirmed real mechanism** — `testCases` with per-task mocking + assertions. Strongest differentiator. |
| Identity/auth model fit (Entra app-only) | Fits directly, already this project's pattern | Fits directly for the REST-task fallback (same pattern); Dataverse-connector path's auth fit is unconfirmed |
| Multi-tenant/per-project fit | Confirmed, per-project SA | Confirmed equivalent, per-project SA (in fact resolves the "shared vs. per-flow SA" open question by not offering a choice) |
| Cost shape | 3 separate billing lines, unpriced against real flow volume | Pay-as-you-go + per-connector-node + per-GiB, unpriced against real flow volume; Dataverse connector specifically capped at 25 tx/sec/node (50 tx/sec on the 2 free nodes) — a real throughput ceiling for high-volume Dataverse CRUD customers that Cloud Workflows' plain HTTP calls don't have |
| Interaction with existing accepted architecture (`secretManager.ts`, `parseFlowId()`, Interactions API call) | Reuses all three as designed | Reuses all three identically — **not a differentiator either way** |

**Decision (recommendation, pending user sign-off)**: adopt **Application Integration** as
the single headless execution engine for all migrated flows — not a hybrid split by flow
type. The hybrid option (Application Integration for CRUD-heavy/branching flows, Cloud
Workflows-style REST-task pattern for `msdyn_*`-heavy flows) was considered and rejected:
because the `msdyn_*` REST-task fallback is identical on both engines, running two
different execution engines for two different flow subsets would double the
deployer/verifier code surface (`flowDeployer.ts`, `verifyFlow.ts`) for no fidelity gain —
every flow, regardless of its `msdyn_*` density, gets the same REST-task treatment for
those specific actions either way. A single engine that natively covers more of the
control-flow graph (loops, sub-flow calls) **and** has a confirmed, working verification
story is a stronger, simpler call than maintaining two runtimes. The Dataverse-connector
CRUD advantage is treated as a bonus to attempt, not a load-bearing part of the decision —
`flowMapper.ts` defaults to the REST-task fallback for CRUD until §9 #8 is confirmed, so
the recommendation holds even in the worst case where the connector auth never pans out.

**What this recommendation does NOT decide**: §9 #8 (connector auth) and §9 #9 (mocking
safety) remain open, live-tenant-confirmation items — they gate specific code paths
(preferring the connector over the REST fallback; trusting mocked verification against
production tenants), not the overall engine choice itself.

**Required before implementation starts**: the user's own explicit approval of this engine
re-decision — not this Architect's, not a peer `backend-connectors` session's — per this
project's rule that an IR/execution-contract-shape decision is a product call. A
`decisions.md` entry has been added (2026-09-03, appended after the original
headless-vs-agent-tool entry, not editing it) recording this recommendation and its
open items; that entry documents the recommendation being made, not yet the user's
approval of it.
