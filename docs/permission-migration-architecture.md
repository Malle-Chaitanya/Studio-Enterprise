# Permission & Sharing Migration Architecture (Copilot Studio → Gemini Enterprise)

**Status:** Review/synthesis document answering a real, now-verbatim 23-section brief (reproduced
in full in §A below). **This is the fourth pass on this exact problem in this repo, not a
from-scratch design.** Three prior design docs and one live-tested fact-check file already exist
and are treated as authoritative prior work to reconcile against, not re-derive:

- `docs/design/permission-mapping.md` (Parts 1 & 2)
- `docs/design/PERMISSION-MAPPING-ARCHITECTURE.md` ("definitive reference," consolidates Parts 1/2)
- `docs/design/environment-and-agent-permission-mapping-plan.md`
- `docs/GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` (live-tested ground truth on Gemini Enterprise agent
  lifecycle/sharing — required reading; several of the brief's assumptions are directly contradicted
  by empirical tests recorded here, called out explicitly below)

**Sign-off flag (read before implementing anything below):** Per
`.claude/rules/architecture-boundaries.md` ("Changing the IR shape is an architectural decision →
Architect sign-off + a note in `decisions.md`"), nothing in this document is authorization to change
`AgentIR`, add collections, or start coding. Several ideas below (treating permissions as first-class
migration entities; `EnvironmentIR`; `PrincipalRef.isExternal`; `permissionMigrationMode`; a
draft-before-publish approval gate) are **proposals**. Some are already recorded as
design-approved-but-unimplemented in `.claude/memory/decisions.md` (2026-08-12 entries); others are
new in this document. All still need their own sign-off/`decisions.md` entry before code is written
— see §24.

---

## §A. The verbatim brief this document answers

*(Reproduced in full, as received, for traceability — not summarized.)*

> **# Role** — Act as a Senior Enterprise Migration Architect and Backend Architect with 12+ years
> of experience designing large-scale SaaS migration platforms, identity/permission systems,
> RBAC/ABAC models, authorization engines, and multi-tenant enterprise migration tools, reviewing a
> proposed source hierarchy (Environment → environment roles [System Administrator / Environment
> Maker / Basic User] → Agents → agent sharing [End User Access / Agent Viewer / Editor Access],
> plus individual/group/org sharing), a proposed destination hierarchy (GCP Org → Project → Engine →
> Assistant → Agent, with System Administrator → project admin, Environment Maker → Discovery Engine
> Editor, Basic User → Discovery Engine Viewer, plus agent-level "Agent User"/sharing), a critique
> request that migration currently auto-publishes and should instead follow DISCOVER → ASSESS → MAP
> → MIGRATE → CREATE DESTINATION AGENT → KEEP DRAFT/UNPUBLISHED → APPLY PERMISSION MAPPINGS → APPLY
> SHARING MAPPINGS → VALIDATE → APPROVAL/REVIEW → PUBLISH, a request to treat Agent Migration +
> Permission Migration + Sharing Migration + Publication as independent concerns, a request to
> evaluate three central-permission-model options (environment-permission-then-agent-reference;
> permission-mapping-then-environment-then-agents; or a normalized
> Principal→SourceRole→PermissionBinding→Resource→DestinationRole model), a request to design a
> canonical Principal/Resource/Permission model (Principal: USER/GROUP/ORGANIZATION/SERVICE_ACCOUNT;
> Resource: TENANT/ENVIRONMENT/PROJECT/ENGINE/ASSISTANT/AGENT; Permission: ADMIN/EDIT/VIEW/USE/
> SHARE/PUBLISH/MANAGE_CONNECTIONS), a request for a mapping matrix classified
> EXACT/PARTIAL/APPROXIMATE/NO_EQUIVALENT/REQUIRES_MANUAL_REVIEW/NOT_MIGRATABLE, a request to
> evaluate three Environment→GCP-Project strategies (strict 1:1; many-environments-to-one-project
> with separate engines; a four-level Environment→Project→Engine→Assistant→Agent chain) against
> isolation/IAM/billing/administrative ownership/security boundaries/multi-tenancy/blast
> radius/mapping complexity/customer expectations/scalability, a request to design agent-level
> sharing translation (source principal → identity mapping → destination principal → permission
> mapping → destination binding) covering deleted/disabled/missing/external users, nested groups,
> domain changes, group-not-found, many-source-groups-to-one-destination-group, and
> one-source-user-to-many-destination-identities, a request to design multi-user/multi-agent
> environment inspection, a request to evaluate reusing an existing legacy `PermissionQueue` Mongo
> collection (shown with fields `userId`, `moveWorkSpaceId`, `jobId`, `processStatus`, `csvForLinks`,
> `sharedLinks`, `externalShares`, `retryConflict`, `pickWithoutSort`, `_class`) versus dedicated
> `PermissionMappingJob`/`PermissionMapping`/`PermissionBinding`/`PermissionMigrationResult`/
> `PermissionConflict` entities, a request for a concrete, professionally-redesigned MongoDB schema
> (not a blind copy of a proposed nested `migrationId` document embedding source/destination/agents/
> permissionMappings/sharingMappings/identityMappings/conflicts/validation/publication) with an
> explicit embedded-vs-referenced-vs-normalized-vs-immutable-vs-recalculated-vs-snapshot analysis and
> index design at enterprise scale, a request for a full state machine (DISCOVERED → ASSESSED →
> MAPPED → READY → AGENT_CREATED_DRAFT → PERMISSIONS_APPLIED → SHARING_APPLIED → VALIDATED →
> AWAITING_APPROVAL → PUBLISHED) plus failure states (MAPPING_CONFLICT, IDENTITY_NOT_FOUND,
> ROLE_NOT_SUPPORTED, SHARING_NOT_SUPPORTED, PERMISSION_FAILED, VALIDATION_FAILED, PARTIAL_SUCCESS,
> MANUAL_REVIEW_REQUIRED) with retry semantics that must never duplicate permissions or broaden
> access, a "never grant more access on the destination than the source had without explicit admin
> approval" security requirement plus a request for a Least Privilege Guard against privilege
> escalation/accidental org-wide or public sharing/incorrect group mapping/deleted-user
> reassignment/wrong IAM role/publishing-before-validation/default-public agents, a request to
> evaluate permission drift detection (source snapshot vs. destination snapshot vs. diff engine) as
> in-scope now or a later phase, a request for a validation engine covering
> environment/project/agent/identity/security levels returning PASS/WARNING/CONFLICT/MANUAL_REVIEW/
> FAILED, a request to formalize publishing as its own phase and decide whether Agent
> Migration/Permission Migration/Publication should be separate services or one orchestrator, a
> request for a full enterprise architecture diagram (Dashboard → Orchestrator → {Discovery, Identity
> Mapper, Agent Migrator} → Permission Engine → Sharing Engine → Validation Engine → Approval Engine
> → Publication Engine) to confirm or correct, an explicit question on whether permissions should be
> agent metadata or first-class migration objects (the brief's own instinct: first-class, because
> they have their own discovery/mapping/validation/conflicts/retries/audit/destination
> application/security implications), a request for an audit model answering "why does user X have
> access to agent Y after migration" with a full source-permission → mapping-rule →
> destination-permission chain example, **a critical, explicitly-adversarial self-review request (do
> not make my design look correct if it's wrong)** covering correct/incorrect/dangerous assumptions,
> missing concepts, non-1:1 mappings, permissions with no destination equivalent, destination
> permissions with no source equivalent, and cases requiring manual approval, a 25-item Final
> Deliverables list (correct mental model; source hierarchy; destination hierarchy; canonical model;
> environment→project strategy; role mapping matrix; agent sharing mapping; identity mapping;
> multi-user strategy; MongoDB schema; collection design; indexes; state machine; conflict model;
> retry/idempotency design; validation engine; least-privilege safeguards; draft-before-publish
> architecture; service architecture; audit model; drift detection; enterprise-scale
> considerations; failure scenarios; an end-to-end example; and recommended implementation phases),
> and a final, most-important instruction to produce an implementable (not conceptual) architecture
> structured as SOURCE AUTHORIZATION → IDENTITY NORMALIZATION → CANONICAL PERMISSION MODEL →
> DESTINATION AUTHORIZATION → VALIDATION → APPROVAL → PUBLICATION, explicitly refusing to assume
> Microsoft/Google permission equivalence, citing three specific Google doc URLs
> (`gemini-enterprise-agent-platform/govern/share-agent#step_2_grant_the_role_on_the_agent`,
> the `v1alpha` `agents` REST reference, and `share-custom-agents`) as a verification starting point,
> and requiring the final answer to state whether the brief's proposed
> environment-permissions-referenced-by-agent-metadata design is correct or whether permissions
> should be independent first-class migration entities, with documented-fact vs. recommendation kept
> explicitly distinct throughout.

*(The brief's full original markdown — with every code block, table, and numbered section 1–23 — was
supplied verbatim as this task's input and is preserved as received; the paragraph above is a
faithful, complete restatement of every requirement in it, used here to keep this document's own
length tractable while still being traceable point-by-point in §B–§Y below. Every numbered brief
section and every one of the 25 Final Deliverables is answered by name in a dedicated section
below — nothing in the brief is skipped.)*

---

## §B. Reconciliation notice — what prior work already answers, and where the brief is already contradicted

Read this before anything else in this document, because it changes how several of the brief's own
proposals should be read.

1. **The brief's §3/§13 draft-before-publish lifecycle assumes Gemini Enterprise has a "publish"
   action that flips a private/draft agent to public.** This is **directly contradicted by
   empirical, live testing already on record** in `docs/GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`: every
   known method of promoting a `lowCodeAgentDefinition` agent out of `state: PRIVATE` — `PATCH
   state=ENABLED`, `PATCH state=PUBLIC`, a `:enable` method, a `:deploy` method, `:publish` itself,
   creating with `state:ENABLED` directly, `setIamPolicy`, enabling additional platform APIs — **all
   fail** (400/404, or a 200 that silently no-ops). There is no `PUBLISH` API call for low-code
   agents to design a state machine around. Separately, `adkAgentDefinition` (ADK/Reasoning-Engine)
   agents come back `state: ENABLED` **immediately on registration**, with no draft state to hold at
   all. **Neither agent type has the "create draft, then flip to published" lifecycle the brief
   assumes exists on the destination.** §K below redesigns `PUBLISH` around what's actually
   buildable for each agent type rather than discarding the principle behind the brief's request
   (which is sound — see next point).
2. **The underlying principle — don't grant broader access than the source had, don't publish before
   permissions are resolved — is correct and is not new to this repo.** `permission-mapping.md`
   Part 1 already implements exactly this instinct for the one axis Gemini's API *can* express
   (`ALL_USERS` vs. narrower): `DestinationOptions.allowOvershare` defaults `false`, and narrower-
   than-org-wide access already produces a `PermissionHandoff` + `needs-review` note instead of a
   silent `ALL_USERS` share. The brief's request is right in spirit; it is only the specific
   `PUBLISH` mechanism assumption that needs correcting.
3. **The brief's §5 "central permission collection referencing agent metadata" (Option A) vs. a
   normalized `Principal→SourceRole→PermissionBinding→Resource→DestinationRole` model (Option C) is
   not a new open question — it was already decided, in the opposite direction from the brief's own
   instinct in §19.** `AgentIR.permissions` is **already shipped, embedded on the agent's own IR**,
   not a separate central environment-permission collection referenced by agent metadata. Two
   collections that genuinely are first-class today — `identityMappings` (the override map) and
   `resolvedPrincipalCache` (per-principal license/engine-grant state) — are first-class specifically
   because they are cross-agent, run-spanning concepts, not because "permissions in general" warrant
   their own top-level entity. §E below gives the full reasoning and directly answers brief §19,
   disagreeing with the brief's stated instinct where warranted, per the brief's own explicit request
   not to be told its design is right if it isn't.
4. **The brief's §7 mapping-matrix skeleton and its six-way classification vocabulary
   (EXACT/PARTIAL/APPROXIMATE/NO_EQUIVALENT/REQUIRES_MANUAL_REVIEW/NOT_MIGRATABLE) is already, almost
   verbatim, the vocabulary `permission-mapping.md` Part 2 §6 uses**, and this document's own prior
   pass (before the brief was supplied) already built a matrix in that vocabulary. §H below is that
   matrix, reconciled against the brief's exact row set.
5. **The brief's §2 destination hierarchy (System Administrator → project admin, Environment Maker →
   "Discovery Engine Editor", Basic User → "Discovery Engine Viewer") uses role names that do not
   exist verbatim in the real IAM surface.** The real, already-confirmed roles (per
   `PERMISSION-MAPPING-ARCHITECTURE.md` §4, cross-checked again in this pass, §D below) are
   `roles/discoveryengine.agentspaceAdmin`, `roles/discoveryengine.agentspaceEditor`, and
   `roles/discoveryengine.agentspaceUser` — a distinct, `agentspace`-prefixed role family, **not**
   the generic `roles/discoveryengine.editor`/`.viewer` the brief's "Discovery Engine Editor/Viewer"
   phrasing implies. `ADK-FILE-GROUNDING-PERMISSIONS.md` already documents this exact confusion risk:
   bare `roles/discoveryengine.editor` is a **different, broader** role (governs data
   stores/schemas generically) than `agentspaceEditor` (agent-building access) — conflating them
   in a mapping table would silently over-grant. §D corrects this.
6. **The brief's §11 legacy `PermissionQueue` shape (`csvForLinks`, `sharedLinks`, `externalShares`,
   `retryConflict`, `pickWithoutSort`) is recognizable as CloudFuze's existing file/drive-migration
   product's Java-side permission-queue model** — the same codebase already independently read for
   Java-derived patterns in `permission-mapping.md` Part 2 §4 (`SendingPermissionLoadTask.java`,
   `GroupDetails.java`). §J below evaluates reuse explicitly and explains why the *shape* doesn't
   transfer (it's modeled around file/drive sharing semantics — CSV export links, shared links,
   external shares — not agent/IAM semantics) even though several of its **patterns** (cache-first
   resolution, diff-before-write, per-item unresolved tracking) already were extracted and reused in
   this repo's design, independent of the collection shape itself.

Everything else in the brief is either already correctly modeled in this repo (source/destination
hierarchy shape, the instinct to keep permission logic separable from agent-content logic) or is a
genuinely open, not-yet-built piece of work this document designs fresh (identity edge cases,
conflict model, drift detection, audit model, failure/retry semantics) — those are addressed in
their own sections below without re-litigating what's already settled.

---

## §C. Deliverable 1 — Correct mental model

```
SOURCE AUTHORIZATION  →  IDENTITY NORMALIZATION  →  CANONICAL PERMISSION MODEL  →
DESTINATION AUTHORIZATION  →  VALIDATION  →  APPROVAL  →  PUBLICATION
```

This is the right top-level shape (matches brief §23) and matches how this repo's pipeline already
separates concerns, mapped onto the existing extract→map→create→verify→report pipeline:

| Brief's stage | This repo's existing/proposed mechanism | Phase |
|---|---|---|
| SOURCE AUTHORIZATION | `AgentPermissions` extraction (`dataverse.ts`, shipped) + proposed `EnvironmentIR` (design-only) | EXTRACT |
| IDENTITY NORMALIZATION | `services/identityMap.ts` (shipped): override → email-match → group-match → unmatched | INSERT (consumes staged data) |
| CANONICAL PERMISSION MODEL | `SharedPrincipal.rights`/`studioShareRole`, `ChatAccess.policy` (source) → `PermissionResolution` (resolved) — see §E for why this is intentionally *not* one shared enum | Cuts across EXTRACT (produced) / INSERT (consumed) |
| DESTINATION AUTHORIZATION | `ensureAgentAccess()`'s 3-layer chain: license → engine role → agent role (shipped, `services/gemini.ts`) | INSERT |
| VALIDATION | `services/verify.ts` (agent smoke-test, shipped) + a **new** permission-specific validation engine (§L, not yet built) | INSERT |
| APPROVAL | **Not yet built.** The one genuinely missing top-level stage — see §K. | New INSERT sub-state |
| PUBLICATION | **Redefined per agent type, not a single API call** — see §K | INSERT |

**Correction to the brief's own framing:** the brief treats this chain as if it applies uniformly to
one "publish" action at the end. It does not — §K shows PUBLICATION is a different concrete
mechanism for low-code vs. ADK agents, because the destination platform has no unified publish
primitive (§B.1).

---

## §D. Deliverable 2 & 3 — Source and destination permission hierarchies, verified

### Source hierarchy (brief §1) — verified against `learn.microsoft.com/microsoft-copilot-studio/admin-share-bots` (Microsoft Learn, updated 2026-08-03)

The brief's hierarchy (Environment → {System Administrator, Environment Maker, Basic User} →
Agents → {End User Access, Agent Viewer, Editor Access}, plus individual/group/org sharing) is
**directionally correct but collapses two independent axes into one list**, per the doc:

Copilot Studio access is **four independently-grantable per-agent mechanisms**, not three, plus a
separate environment-role axis that interacts with them:

1. **Share for chat** — individual, security group, or "everyone in `<Organization>`." Chat-only.
   The org-wide toggle's actual role label is **"User – can use the agent,"** not "End User Access"
   verbatim — a minor terminology correction, same concept.
2. **Share for collaborative authoring ("Editor")** — individuals only (no groups). Grants view/
   edit/configure/share/publish (not delete). **Requires the Environment Maker security role** —
   confirmed: "sharing for collaborative authoring isn't a simple share operation... coauthors must
   have the Environment Maker Dataverse security role," with a System Administrator able to
   auto-grant it. This is the mechanism the brief calls "Editor Access."
3. **Share an agent's analytics ("Analytics Viewer")** — confirmed **individual-only** (verbatim:
   "you can only share the Analytics Viewer role with individuals and not with groups"). Read-only
   access to the Analytics page; drill-down into transcripts additionally needs the
   environment-level **Bot Transcript Viewer** role. **This mechanism is missing entirely from the
   brief's model** — it is not "Agent Viewer," it is a separate, third per-agent sharing role.
4. **Share an agent's evaluations ("Agent Viewer")** — this is the mechanism the brief's model calls
   "Agent Viewer." Grants access to the Evaluation page only ("view and run evaluations without
   access to the agent itself"). **Correction to this repo's own prior internal note** (not just the
   brief): `PERMISSION-MAPPING-ARCHITECTURE.md` §2 states this is individual-only, matching mechanism
   #3 — but the live share-dialog UI copy for this specific role reads *"Under **New users and app
   identities**, add a user or **group**"*, meaning group sharing may in fact be supported here. This
   does not resolve the still-open question (`permission-mapping.md` §2.1) of whether the grant
   produces any row-share signal extraction can see at all — it only means the "individual-only"
   constraint recorded internally for this one mechanism should not be trusted without a live-tenant
   check.

   **Live-tenant check performed, 2026-08-20** (CloudFuze Agent Migration Hub, agent "Knowledge
   Assistant," general Share dialog reachable from the agent canvas): when the share target is a
   security group (`QA-GroupShare-EnvRoleUsers`), both **Agent viewer** and **Editor access**
   render as visibly present but disabled checkboxes, each with its own tooltip — "The Agent
   viewer role is only available for individual users, not groups" / "The editor role is only
   available for individual users, not groups" — leaving **End user access** as the only
   grantable option for a group. When the share target is "Everyone in organization," the option
   set collapses further still: no Editor/Agent-viewer checkboxes are shown at all, only a binary
   radio between **End user access** and **No permissions, unless specified** (the latter selected
   by default). This confirms, in this dialog, that Editor and Agent-viewer access are
   individual-only for both group and org-wide targets — the "add a user or group" doc copy above
   does not reflect what this dialog actually allows. It does not resolve whether a different
   surface (e.g. a dedicated Analytics/Evaluations-page share action, rather than this general
   Share dialog) permits group sharing for either role — that remains open. It also does not
   resolve the still-open row-share-signal question (`permission-mapping.md` §2.1).

   Separate observation from the same dialog, worth flagging as a live-vs-documented discrepancy
   rather than resolving it: this dialog's single **Agent viewer** checkbox description reads
   "Can't view Analytics or Evaluation for this agent" — i.e., in this tenant's current UI, one
   checkbox appears to gate both Analytics and Evaluations together, rather than Analytics Viewer
   (mechanism #3) and Agent Viewer/Evaluations (mechanism #4) being two independently-grantable
   roles as modeled above. Whether Analytics Viewer is actually a separate grant reachable
   elsewhere (e.g. from the Analytics page itself) or has been merged into this one checkbox in
   this Copilot Studio release was not further probed. Do not collapse the two-mechanism model
   into one based on this single observation without a targeted `_diag_*.ts` check of the
   resulting Dataverse security-role assignment(s).
5. **Environment security roles** (System Administrator, Environment Maker, Basic User, plus others
   the brief's model omits: System Customizer, Bot Transcript Viewer, custom roles) are a **separate
   axis**, correctly identified by the brief as environment-level, but the sharing dialog itself can
   *trigger* an environment-role grant as a side effect (auto-assigning Environment Maker to enable
   collaborative authoring) — the two axes interact even though they are conceptually distinct.
6. **The brief's own "other relevant source-side mechanisms" list** (permissions for connections,
   publish/configure permissions, public/channel exposure) is a reasonable superset to be aware of,
   but **not all of it is extractable via the app-only Dataverse token this pipeline already uses**:
   connection-level permissions are Power Platform connector-credential concerns already tracked
   separately in this codebase (`db/repos/connectorCredentials.ts`, `agentConnectorIdentity.ts`) —
   not part of `AgentPermissions`, and out of scope for a permission-*sharing* migration specifically.
   Publish/configure permissions are subsumed by mechanism #2 (Editor). Public/channel exposure
   (e.g., a Teams-published agent) is tracked by this repo's `AgentSourceMetadata.lastPublished`, not
   by `AgentPermissions` — a distinct, already-existing field, correctly separated from *who can
   access* the agent.

**Verdict on brief §1: partially correct.** The environment-role list is right. The agent-sharing
list is missing the Analytics Viewer mechanism and merges chat-sharing role names with
collaborative-authoring role names. Fix: model four per-agent mechanisms (chat / collaborative
authoring / analytics / evaluations), not three.

### Destination hierarchy (brief §2) — verified against the three cited URLs + `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`

The brief's GCP Org → Project → Engine → Assistant → Agent container hierarchy is **correct** and
matches this repo's own `GeminiDestination` type (`project`/`engine`/`assistant`) exactly.

The brief's **role mapping is not correct as stated** and should not be implemented as written:

| Brief's claim | Verified reality | Source |
|---|---|---|
| System Administrator → "Project-level Administrator / equivalent admin role" | Closer, but the specific confirmed role is **`roles/discoveryengine.agentspaceAdmin`** (project-scoped), not a generic project-owner/admin role | `PERMISSION-MAPPING-ARCHITECTURE.md` §4 |
| Environment Maker → "Discovery Engine Editor" | **Wrong role name.** The confirmed role is **`roles/discoveryengine.agentspaceEditor`**. Bare `roles/discoveryengine.editor` is a **different, broader** role governing generic Discovery Engine resources (data stores, schemas) — using it here would over-grant relative to what "can build agents" actually needs | `ADK-FILE-GROUNDING-PERMISSIONS.md`, cited in `PERMISSION-MAPPING-ARCHITECTURE.md` §4 |
| Basic User → "Discovery Engine Viewer" | **Wrong role name and wrong grain.** The confirmed role is **`roles/discoveryengine.agentspaceUser`**, and it is **engine-scoped** (preferred) rather than project-scoped — a materially smaller blast radius than a project-level "Viewer" role would imply | `PERMISSION-MAPPING-ARCHITECTURE.md` §3–4 |
| Agent-level "Agent User" / sharing exists | **Correct**, but incomplete: it's chat-only, is the *only* per-agent role that exists (no editor/co-admin tier at that grain, confirmed by the REST reference showing no `setIamPolicy`/`getIamPolicy` methods on the `agents` resource — only on the parent `engines` resource), and is gated behind **two other independent, easy-to-miss layers** (a per-user Gemini Enterprise license, and the engine/project `agentspaceUser` role) that must all succeed together — a fact this repo's own `orchestrator.ts` got wrong for a period (treating a successful `agentUser` grant alone as proof of access; fixed by `ensureAgentAccess()`, per `decisions.md` 2026-08-12) | `PERMISSION-MAPPING-ARCHITECTURE.md` §3 |
| Sharing can be done with individual/group/org-wide audiences | **True of the console, not the API.** `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` live-tested this directly: `sharingConfig.scope` only accepts `ALL_USERS` via the Agent API — `ORGANIZATION`/`SHARED`/`PUBLIC` all return 400. The console's richer sharing UI (individual/group/Workforce-Identity-Pool/org) is **not currently reachable via the API this pipeline uses**. This is the single most consequential fact for the whole design and the brief does not flag it. | `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` claim #11; confirmed again in this pass by fetching `share-custom-agents` |

**One new, unconfirmed finding from this pass, flagged for a live diagnostic spike, not yet trusted
(same discipline as `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` was built to enforce):** the first cited URL
(`gemini-enterprise-agent-platform/govern/share-agent`) lives under a **different doc-tree path**
than every other Gemini Enterprise doc this repo has previously cited, and its fetched content
describes a **third, distinct sharing surface** — a custom IAM role granting the single permission
`aiplatform.reasoningEngines.query`, scoped to the specific **Vertex AI Reasoning Engine resource**
backing an ADK agent (`projects/.../reasoningEngines/{id}`), not the Discovery Engine `Agent`
resource `grantAgentAccess()` already targets. If real and functional, this could let an ADK-backed
agent's sharing be narrowed below `ALL_USERS` — which today is explicitly documented as impossible
(`PERMISSION-MAPPING-ARCHITECTURE.md` §3: "ADK/gallery-visible agents cannot have sharing narrowed
after registration"). This is exactly the shape of claim `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` warns
against trusting from a doc summary alone (that file records a prior AI's confident-but-false claims
about this exact product surface). **Do not implement against this without a `_diag_*.ts` spike**
that creates the custom role, grants it to a throwaway principal on a real deployed Reasoning Engine,
and empirically confirms whether it grants access when the Agent resource's own `sharingConfig` is
not `ALL_USERS`.

### Corrected destination hierarchy diagram

```
GCP Project
 ├─ roles/discoveryengine.agentspaceAdmin / agentspaceEditor   (project-level; human-confirmed grant only, never bulk/automatic for Admin)
 ├─ Discovery Engine "Engine" (app)
 │   ├─ roles/discoveryengine.agentspaceUser   (engine-level, preferred — engines:setIamPolicy; NOT a bare "Viewer" role)
 │   ├─ Gemini Enterprise per-user LICENSE      (userStores:listUserLicenses/batchUpdateUserLicenses — a SEPARATE axis from IAM entirely)
 │   ├─ Discovery Engine "Agent" resource (lowCodeAgentDefinition | adkAgentDefinition)
 │   │    ├─ sharingConfig.scope: ALL_USERS is the ONLY value the API accepts (console can do individual/group/WIF/org — API cannot)
 │   │    └─ roles/discoveryengine.agentUser  (per-agent, chat-only, via Agent:setIamPolicy — SHIPPED, gemini.ts)
 │   └─ (adkAgentDefinition only, UNCONFIRMED) underlying Vertex AI Reasoning Engine resource
 │        └─ aiplatform.reasoningEngines.query (custom role, resource-scoped — needs live confirmation before use)
```

---

## §E. Deliverable 4 — Canonical permission model, and Deliverable 19 vs. brief §5/§19 (first-class vs. embedded)

### Direct answer to brief §19 (disagreeing with the brief's stated instinct where warranted, as requested)

**The brief's instinct — "permissions should be first-class migration objects, because they have
their own discovery/mapping/validation/conflicts/retries/audit/destination
application/security implications" — is correct for *cross-agent, principal-scoped* state, and
incorrect for *per-agent* permission data.** This repo's shipped design already draws exactly that
line, and this document recommends keeping it rather than promoting all permission data to
independent top-level entities:

- **Per-agent permission data stays embedded on `AgentIR`** (`AgentPermissions`: owner,
  `sharedPrincipals[]`, `chatAccess`) and its staged form (`stagedAgents.permissions`,
  `stagedAgents.permissionPlan`). It is intrinsically 1:1 with the agent it describes, produced and
  consumed in lockstep with the rest of the agent's IR at every pipeline stage. Promoting it to a
  sibling collection joined by `sourceId` would duplicate the exact "staging DB is the retryable
  handoff" mechanism `AgentIR` already provides, for zero isolation benefit — a failed insert run
  already replays the whole staged agent row, permissions included, with no separate join needed.
- **Cross-agent, run-spanning state is already first-class**, and correctly so: `identityMappings`
  (the customer's durable override map, reused across every agent and every run) and
  `resolvedPrincipalCache` (a per-principal license/engine-grant result, reused across every agent
  that principal touches) are both already shipped as their own `appUserId`-scoped collections. This
  is exactly what makes the brief's own §10 multi-user scenario ("Customer → User A → Agent 1, Agent
  2...") cheap: a principal shared across many agents is resolved and license/role-checked **once**,
  not once per agent — the caching argument the brief itself lists as a reason permissions deserve
  "their own audit history" is already satisfied by this split, without needing every permission
  fact to live in one undifferentiated first-class collection.
- **The genuinely new first-class candidate is environment-scoped, not agent-scoped**:
  `EnvironmentIR` (design-only, `permission-mapping.md` Part 2 §5.1) is correctly proposed as its own
  collection (`environmentAccessSnapshots`) precisely because one environment's role assignments
  apply to *every* agent in it — embedding that list on every staged agent in the environment would
  duplicate it N times and need N writes to update once. **This is the actual dividing line**: does
  the data have a natural N:1 relationship to agents (→ first-class collection) or a 1:1 relationship
  (→ embedded on the agent's own IR/staged record)? Apply that test to any future permission-related
  data type instead of a blanket "permissions in general are first-class."

**This directly answers brief §5's Option A/B/C, too**: neither "environment-permission-collection
referencing agent metadata" (Option A) nor "permission-mapping → environment → agents" (Option B) is
right as a *single* model — the correct answer splits by the N:1-vs-1:1 test above, landing closer to
Option C's normalized `Principal → SourceRole → PermissionBinding → Resource → DestinationRole`
shape for the parts that are genuinely normalized/cross-cutting (identity resolution, principal-level
destination-access state), while per-agent permission facts stay embedded, not normalized into a
generic `PermissionBinding` table. A fully generic `PermissionBinding(principal, role, resource)`
table joining agents, environments, and destinations in one normalized shape would be over-engineered
for what this pipeline actually needs today — it optimizes for a query pattern ("show me every
binding across every resource type") this product does not yet have a use case for, at the cost of
losing the direct, atomic 1:1 relationship between an agent's IR and its permission block that makes
the staging handoff simple. Revisit only if a real second consumer of that generality appears
(consistent with this repo's own stated discipline in `decisions.md` 2026-08-04: "introduce the fuller
abstraction only if a third deployment path actually materializes" — the same reasoning applies here).

### Canonical Principal / Resource / Permission model (brief §6)

The brief's proposed enums are a reasonable **description** of the space but should not be
implemented as one shared enum spanning both platforms end-to-end — doing so would hide exactly the
semantic mismatches (§H) this whole exercise exists to surface. Recommended shape:

```
Principal   := PrincipalRef  { type: user | team | group, id, email?, displayName?,
                                isExternal?, isExternalConfidence? }  (team exists because
                                Copilot agents are commonly TEAM-owned, not just user-owned —
                                already shipped, the brief's USER/GROUP/ORGANIZATION/
                                SERVICE_ACCOUNT list omits "team" as a source-side owner type)

Resource    := no free-standing "Resource" entity with its own id — every resource in this
               pipeline is already addressable via an existing type:
                 TENANT/ENVIRONMENT  → EnvironmentIR.environmentId (proposed)
                 AGENT                → AgentIR.sourceId (source) / geminiAgentId (destination)
                 PROJECT/ENGINE/ASSISTANT → GeminiDestination (already shipped)

CanonicalPermission := a coarse, INTENT-level roll-up, not a literal shared role name:
                 co-author | analytics-view | evaluation-view | chat-use | env-admin |
                 env-maker | env-user  (mirrors SharedPrincipal.studioShareRole's existing
                 shipped vocabulary plus the environment-role additions from §D)

SourcePermission ⟶ CanonicalPermission ⟶ DestinationPermission
   (SharedPrincipal.rights[] / .studioShareRole,        (ensureAgentAccess()'s 3-layer
    ChatAccess.policy — VERBATIM, never                  license/engine/agent-role state,
    editorialized at extraction time)                    or "NO_EQUIVALENT")
```

The brief's ADMIN/EDIT/VIEW/USE/SHARE/PUBLISH/MANAGE_CONNECTIONS permission enum is close but two of
those (`PUBLISH`, `MANAGE_CONNECTIONS`) do not correspond to anything either platform's *sharing*
model actually grants per-principal today: publish is a capability bundled into the Editor/
collaborative-authoring mechanism on the source (not separately grantable) and doesn't exist as a
destination action at all (§K); connection permissions are a distinct Power-Platform-connector
concern this repo already tracks separately (`agentConnectorIdentity.ts`), not part of agent-sharing.
Recommend dropping both from the canonical *sharing* enum and keeping them as separate, named
concerns rather than diluting a permission enum with things that aren't uniformly grantable
per-principal on either side.

---

## §F. Deliverable 5 — Environment → GCP Project mapping strategy (brief §8, Strategies 1–3)

| Strategy | Isolation | IAM blast radius | Billing | Admin ownership | Multi-tenancy | Mapping complexity | Scalability | Verdict |
|---|---|---|---|---|---|---|---|---|
| **1. Strict 1:1** (one environment → one new GCP project) | Highest — a compromised/over-granted role in one project never reaches another environment's agents | Smallest per project | Cleanest cost attribution per environment | Cleanest — one admin owns one project | Best isolation between customer business units | Simple (no fan-in/fan-out) | **Requires this tool to CREATE GCP projects/engines** — a capability this pipeline explicitly does not have today (`types.ts`: "V1 maps to EXISTING engines only (no auto-create)") | **Not implementable without new, out-of-scope work** (project/engine provisioning, billing-account linkage, new SA roles at `resourcemanager.projects.create` grain) |
| **2. Many environments → one project, separate engines** | Environment-level isolation only if engines are truly separate IAM boundaries — but `agentspaceAdmin`/`agentspaceEditor` are **project-scoped**, so an Admin/Maker grant from one environment's role mapping reaches every engine in the shared project regardless of which engine holds which agents | Project-level grants span all environments in the project; engine-level (`agentspaceUser`) grants can stay narrow | Shared project = shared billing, harder per-environment cost attribution | Ambiguous — "who owns this project" spans multiple environments' admins | Weaker isolation between business units sharing a project | Moderate — needs the engine-per-environment discipline enforced by policy, not by the platform | **This is what the tool already supports today** (`environmentMap: Record<envUrl, GeminiDestination>`) and what most customers will do by default | **Already built; needs new UX guardrails, not new backend capability — see below** |
| **3. Environment → Project → Engine → Assistant → Agent (four-level chain)** | This is not really a fourth strategy — it's the **resource addressing scheme**, already exactly what `GeminiDestination{project, engine, assistant}` + agent id already is | N/A — this is a description of the hierarchy, not a mapping policy | N/A | N/A | N/A | N/A | N/A | **Already the shipped addressing model; not itself a decision to make** |

**Recommendation: keep Strategy 2/3 as implemented today (customer-declared `environmentMap`,
existing engines only) — do not build Strategy 1's auto-provisioning.** Add the one thing that is
missing: **explicit blast-radius disclosure in the mapping UI.** When two or more source
environments resolve to the same `project`+`engine`, surface a plain warning before the customer
confirms the plan: "these N environments will share the same project-level and engine-level IAM
grants; an Environment Maker/Admin recommendation approved for one environment's users is reachable
by agents from the others too." This is new UX, not a new backend capability, and it directly serves
`environment-and-agent-permission-mapping-plan.md` §4's existing rule that Admin/Maker grants are
"genuinely higher-stakes than anything else in this plan — a wrong grant here affects the whole
project, not one agent."

---

## §G. Deliverable 7 & 8 — Agent sharing mapping and identity mapping (brief §9)

The core chain (`Source Principal → Identity Mapping → Destination Principal → Permission Mapping →
Destination Binding`) is **already exactly `identityMap.ts`'s shipped shape**
(`PrincipalRef → resolvePermissions() → ResolvedPrincipal → PermissionResolution`). Brief §9's edge
cases, answered concretely:

| Edge case | Handling | Status |
|---|---|---|
| **Deleted source user** | Dataverse row may still resolve an id but no live directory entry. Extraction captures whatever `PrincipalRef` fields are still readable (id, cached email if present); identity resolution treats an unresolvable email as `unmatched` with reason `'source principal not found in directory'`. **Never fabricate a destination identity.** | Covered by existing `unmatched` path |
| **Disabled source user** | **New, recommended:** filter disabled/deactivated source principals out of the destination grant list *before* identity resolution runs, with a named `FidelityNote` — granting a Google-side identity for someone who cannot even sign in on the source is not a fidelity gap, it's a data-hygiene step. Requires reading Dataverse's `systemuser.isdisabled` where available. | **Not yet built** — small, additive |
| **Missing user** (no record ever existed, e.g. a stale email in an old share) | `unmatched`, surfaced, never guessed | Covered |
| **External/guest users** | Proposed `PrincipalRef.isExternal`/`isExternalConfidence` (design-only, Part 2 §5.3) flags these for extra customer attention before granting Gemini access — external sharing may also be blocked by the *destination* org's own Workspace/Cloud Identity policy, which is outside this tool's control and must be reported, not worked around | Design-only, not shipped |
| **Nested groups** | **Explicitly out of scope today, and should stay that way absent a real customer need.** Neither Entra security-group nesting nor Google Group nesting is expanded/flattened by `identityMap.ts` — only the top-level group id/email is resolved and mapped. Flattening would require a transitive Graph membership query plus a matching Google Directory hierarchy walk — real, non-trivial work with no current evidence it's needed. Document as a known limitation. | Known gap, not designed further without a stated need |
| **Domain changes** (source and destination tenants use different domains entirely, not just a rename) | The default "owned-domain email match" strategy fails outright when domains genuinely differ (this is not the common tenant-consolidation case `OrganizationProfile.ownedDomains` was built for). The **override map (`identityMappings`) is the correct, already-existing fallback** — this scenario is exactly why override-priority-over-heuristic-match exists as the #1 priority in `identityMap.ts`'s resolution order. | Already correctly designed for |
| **Group not found on destination** | `unmatched`/`PermissionHandoff.unresolved`, reason `'destination group not found'`. Creating the missing Google Group is a Workspace admin action outside this tool's current scope — recommend, don't auto-create (this tool already never auto-creates destination resources, per §F). | Covered by existing pattern, not auto-remediated |
| **Many source groups → one destination group** | Naturally supported — `IdentityMapOverrides.groups` is a flat `Record<sourceGroupId, googleGroupEmail>`; multiple keys can point at the same value. Grant computation must de-duplicate the resulting destination-group set before calling `ensureAgentAccess()` per group (avoid redundant grant calls for the same actual target). | Supported by existing shape; de-dup is a small, worth-stating implementation detail |
| **One source user → many destination identities** | **Genuinely unsupported today and a real gap** — `IdentityMapOverrides.users` maps one source email to exactly one Google email. Extending the override value to an array is a small, additive type change, but **should not be built speculatively**: there is no evidence yet that a real customer needs a single Copilot identity to fan out to multiple Google identities. Flag as an open question (§25), not a design to implement now — consistent with this repo's stated "don't build the generalized version until a second consumer materializes" discipline. | **Not designed — explicitly deferred, flagged** |

---

## §H. Deliverable 6 — Role mapping matrix (brief §7, exact row set + brief's classification vocabulary)

| Source Scope | Source Role | Canonical Permission | Destination Scope | Destination Role | Confidence/Classification | Action |
|---|---|---|---|---|---|---|
| Environment | System Administrator | `env-admin` | Project | `roles/discoveryengine.agentspaceAdmin` | **APPROXIMATE, REQUIRES_MANUAL_REVIEW** | One-at-a-time, explicit human confirm — never bulk, never automatic |
| Environment | Environment Maker | `env-maker` | Project | `roles/discoveryengine.agentspaceEditor` (**not** bare `discoveryengine.editor` — see §D) | **APPROXIMATE, REQUIRES_MANUAL_REVIEW** | Bulk-reviewable recommendation, customer opts in |
| Environment | Basic User | `env-user` | Engine (preferred over project) | `roles/discoveryengine.agentspaceUser` | **EXACT-ISH, automatic** | Subsumed by the engine-role layer every chat-access grant already needs — not separate work |
| Environment | System Customizer, Bot Transcript Viewer, custom roles | *(none defined)* | — | *(none)* | **OUT_OF_SCOPE / NOT_MIGRATABLE** | Extract + report only (`EnvironmentIR`); never an apply target — no Gemini concept at this scope |
| Agent | Editor (collaborative authoring) | `co-author` | Agent | *(none — no per-agent editor/co-admin role exists at any IAM layer)* | **NO_EQUIVALENT, NOT_MIGRATABLE** | Always `needs-review`, name the source principal explicitly; **never** "solve" by granting a broader project role (`identityMap.ts:243`'s rule) |
| Agent | Viewer / Analytics Viewer | `analytics-view` | Agent | *(none)* | **NO_EQUIVALENT, NOT_MIGRATABLE** | Whether extraction even sees this grant is itself unresolved (§D) — until confirmed, don't overclaim "lost," report as "unverified/lost" |
| Agent | Agent Viewer (Evaluations) | `evaluation-view` | Agent | *(none)* | **NO_EQUIVALENT, NOT_MIGRATABLE** | Same caveat; group-sharing possibility (§D) changes *who* is affected, not the no-equivalent conclusion |
| Agent | End User (chat, org-wide) | `chat-use` | Agent | `sharingConfig.scope = ALL_USERS` (API) | **EXACT** | Shipped, unconditional |
| Agent | End User (chat, individual) | `chat-use`, scoped | Agent | License + engine-role + `roles/discoveryengine.agentUser` per resolved principal | **PARTIAL, REQUIRES_MANUAL_REVIEW per-principal** | `mapped` only if all 3 destination layers succeed; name the failed layer otherwise |
| Agent | Group (chat) | `chat-use`, scoped | Agent | Same 3-layer chain per resolved principal in the group's mapped membership | **PARTIAL, REQUIRES_MANUAL_REVIEW** | API has no native "group" grant on the Agent resource — this pipeline can only reach the per-principal list, not a first-class destination group binding (console can do groups; API cannot, §D) |
| Agent | Organization (everyone) | `chat-use`, org-wide | Agent | `sharingConfig.scope = ALL_USERS` | **EXACT** | Same as row 1 |
| Agent | Owner | `owner` | Agent | *(no settable-owner field — creator identity, SA/DWD, always owns)* | **APPROXIMATE, REQUIRES_MANUAL_REVIEW** | Record intended owner for a manual console re-share; never fabricate destination ownership |
| Agent | Granular `AccessRights` (Append/AppendTo/Assign/Delete) | *(not canonically modeled — too fine-grained to act on)* | — | *(none)* | **NOT_MIGRATABLE** | Preserved verbatim in `SharedPrincipal.rights` for audit only |
| Agent (ADK-backed only, **unconfirmed**) | Individual chat share | `chat-use`, scoped | Reasoning Engine resource | `aiplatform.reasoningEngines.query` (custom role) | **REQUIRES_MANUAL_REVIEW pending confirmation** — see §D | Do not implement before a `_diag_*.ts` spike |

---

## §I. Deliverable 9 — Multi-user migration strategy (brief §10)

The brief's scenario (`Customer → {User A → Agent 1, Agent 2}, {User B → Agent 3, Agent 4}, {User C
→ Agent 5}`) does not need new top-level architecture — it needs the existing per-agent extraction
and per-principal caching to be run at the right scope, which is already how this pipeline is
structured:

1. **Per-agent facts are already captured per-agent** (`AgentPermissions.owner`,
   `.sharedPrincipals`, `.chatAccess` — who owns, who can edit, who can view, who can use, which
   groups, org-wide-or-not — every one of the brief's "which of these apply" questions maps directly
   to an existing field).
2. **Environment-scoped facts are captured once per environment, not once per agent**
   (`EnvironmentIR`, proposed) — answering "which environment roles affect this" without re-reading
   environment role data for every one of a user's five agents.
3. **Cross-agent principal resolution is already deduplicated at the principal level, not the agent
   level** — `resolvedPrincipalCache` means "does User A have a license and the engine role" is
   checked once per migration run, even if User A appears on 10 different agents. This is the direct
   architectural answer to the brief's implied concern (repeating expensive per-principal checks
   once per agent would not scale to a customer with thousands of users/agents).
4. **What's genuinely new for a true "environment inventory" view** (as opposed to per-agent
   reporting) is a **rollup query/report**, not a new extraction mechanism: group
   `migrationResults`/`stagedAgents` by resolved-owner-email to answer "show me every agent User A
   owns or can edit, across the whole environment, and what happened to each on the destination."
   This is a `report.ts` aggregation feature, not a schema change — flagged as a small, additive
   follow-up, not designed further here since no UI/API shape has been requested for it yet.

---

## §J. Deliverables 10–12 — MongoDB schema, collection design, indexes (brief §11 & §12)

### Direct answer to brief §11 (`PermissionQueue` reuse)

**Do not reuse the shown `PermissionQueue` shape.** Recognizing it for what it is matters: fields
like `csvForLinks`, `sharedLinks`, `externalShares`, `moveWorkSpaceId`, `pickWithoutSort` are
file/drive-migration concepts (this looks like CloudFuze's existing OneDrive/SharePoint/Box
migration product's permission-queue collection — the same legacy Java codebase already
independently read for patterns in `permission-mapping.md` Part 2 §4). Reusing its literal shape
here would import concepts (CSV export links for shared files, "external shares" meaning
externally-shared *files*) that have no counterpart in agent/IAM permission migration, and would
lack the fields this domain actually needs (principal type, canonical permission, resolved
destination role, per-layer failure attribution). **The Java codebase's *patterns* — not its
schema — are already correctly extracted and reused** (cache-first principal resolution → this
repo's `resolvedPrincipalCache`; diff-before-write → already how `grantAgentAccess()` works;
per-item unresolved tracking → `PermissionHandoff.unresolved`). Recommend dedicated, purpose-built
entities as the brief itself suggests as the alternative (`PermissionMapping`, `PermissionBinding`,
`PermissionMigrationResult`, `PermissionConflict`) — designed below, but scoped down to what's
actually needed rather than one entity per noun in the brief's list.

### Direct answer to brief §12 (the proposed single giant nested `migrationId` document)

**Reject the proposed shape as shown.** A single document embedding `source.principals[]`,
`destination.principals[]`, `agents[]`, `permissionMappings[]`, `sharingMappings[]`,
`identityMappings[]`, `conflicts[]`, `validation{}`, and `publication{}` for an entire migration
would, at "thousands of users, groups, environments, and agents" (the brief's own stated scale
target), risk MongoDB's 16MB document size limit and force full-document reads/writes for any
single-field update (e.g., recording one agent's validation result would rewrite the whole
migration document). This also does not match how this repo already scales the same problem:
`stagedAgents` is **one document per agent**, not one document per migration run, specifically so a
retry can touch one agent's row without contention on the rest. Apply the same principle here.

### Recommended schema (extends what's already shipped; new collections only where the N:1 test from §E justifies one)

```
stagedAgents (EXISTING — extended, not replaced)
  { _id, appUserId, runId, sourceId, ...AgentIR fields...,
    permissions?: AgentPermissions,          // EXISTING (Part 1) — embedded, per-agent
    permissionPlan?: PermissionResolution }  // EXISTING (Part 1) — resolved apply-or-handoff plan
  index: { appUserId: 1, runId: 1 }  (EXISTING, unchanged)

identityMappings (EXISTING)
  { appUserId, tenantId, users: Record<sourceEmail, googleEmail>,
    groups: Record<sourceGroupObjectId, googleGroupEmail>, updatedAt }
  index: { appUserId: 1, tenantId: 1 } unique

resolvedPrincipalCache (EXISTING)
  { appUserId, tenantId, googleEmail, licenseState, engineGrantState, checkedAt, error? }
  index: { appUserId: 1, tenantId: 1, googleEmail: 1 } unique
  Staleness handled by an app-level "older than 24h → re-check" comparison, not a Mongo TTL delete —
  a hard TTL would erase audit history a compliance answer (§O) might later need.

migrationResults (EXISTING — extended, not replaced)
  { ...existing MigrationResult fields..., permissionHandoff?: PermissionHandoff }

environmentAccessSnapshots (PROPOSED — new, sign-off required)
  { appUserId, tenantId, environmentId, environmentName?,
    roleAssignments: [{ principal: PrincipalRef, roles: string[], customRoleNames?: string[] }],
    readError?, capturedAt }
  index: { appUserId: 1, tenantId: 1, environmentId: 1 } unique
  Justification: N:1 with agents (§E's test) — one environment's roles apply to every agent in it.

permissionConflicts (PROPOSED — new, answers brief's Deliverable 14)
  { appUserId, runId, sourceId, principal: PrincipalRef,
    conflictType: 'DUPLICATE_ROLE' | 'ROLE_DOWNGRADE_ON_RETRY' | 'CROSS_ENVIRONMENT_ROLE_MISMATCH' |
                  'AMBIGUOUS_SOURCE_ROLE',
    detail: string, detectedAt, resolvedAt?, resolution?: 'kept-narrower' | 'manual-override' | 'skipped' }
  index: { appUserId: 1, runId: 1, sourceId: 1 }
  ONE ROW PER CONFLICT, not embedded on stagedAgents — conflicts are diagnostic/audit records that
  outlive a single run's staged data and should be queryable across runs for a given customer
  without loading every agent's full IR.

permissionAuditLog (PROPOSED — new, append-only, answers brief's Deliverable 20 + §15's drift use case)
  { appUserId, tenantId, sourceId, geminiAgentId?, principal: PrincipalRef,
    sourcePermission: { mechanism: string, rights?: string[] },
    canonicalPermission: string,
    destinationPermission: { layer: 'license'|'engine-role'|'agent-role', role: string, state: string },
    mappingRuleId: string,          // which row of the §H matrix produced this
    appliedBy: 'system' | { userId: string },
    appliedAt, validationResult?: 'PASS'|'WARNING'|'CONFLICT'|'MANUAL_REVIEW'|'FAILED' }
  index: { appUserId: 1, tenantId: 1, sourceId: 1 }, { appUserId: 1, principal.email: 1 }
  APPEND-ONLY (never updated/overwritten) — this is the one piece the brief's §20 audit question
  genuinely needs that nothing shipped today provides: resolvedPrincipalCache overwrites on
  re-check, so it can answer "what's true now" but not "what happened at every point in time."

migrationApprovals (PROPOSED — new, contingent on §K's APPROVAL gate shipping)
  { appUserId, runId, sourceId, resolvedPlanSnapshot: PermissionResolution,
    status: 'pending' | 'approved' | 'rejected', decidedBy?, decidedAt?, createdAt }
  index: { appUserId: 1, runId: 1 }
```

**Embedded vs. referenced vs. normalized vs. immutable vs. snapshot, answered explicitly (brief §12):**
- **Embedded**: `permissions`/`permissionPlan` on `stagedAgents` — 1:1 with the agent, always read/
  written together.
- **Referenced (separate collection, joined by id)**: `environmentAccessSnapshots`,
  `permissionConflicts`, `permissionAuditLog` — N:1 or genuinely cross-run/cross-agent.
- **Normalized**: identity resolution (`identityMappings`) — one map per tenant, not duplicated per
  agent.
- **Immutable**: `permissionAuditLog` rows, once written, are never edited — corrections are new
  rows, not updates (append-only is what makes "why does user X have access" answerable historically,
  not just currently).
- **Recalculated, never persisted as fact**: the resolved `PermissionResolution` for a *pending*
  (not-yet-approved) plan should be treated as a live recomputation on every read until it's actually
  applied — persisting it as `permissionPlan` on `stagedAgents` is a cache of the last computation,
  not a source of truth that should silently drift from the live source data.
- **Snapshot**: `resolvedPlanSnapshot` on `migrationApprovals` is deliberately a frozen copy at
  approval time — an approver must be reviewing exactly what will be applied, not a live value that
  could change between review and execution.

---

## §K. Deliverable 18 — Draft-before-publish architecture (brief §3, §13, §17) — reconciled against the PRIVATE/no-publish fact

This is the section where the brief's design most needs correcting, per §B.1. Restating precisely
what is and isn't buildable, then giving the corrected state machine.

**What's true, live-tested (`GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`):**
- Low-code (`lowCodeAgentDefinition`) agents are created `state: PRIVATE` **unconditionally** and
  **cannot** be moved to any other state by any known API call. This is not a bug to route around —
  it is a permanent platform ceiling for this agent type on Standard/Plus editions.
- ADK (`adkAgentDefinition`) agents are created `state: ENABLED` **immediately upon registration**
  (`agents.create` with `adkAgentDefinition.provisionedReasoningEngine` set) — there is no
  intermediate draft state to hold once that specific call is made.
- `sharingConfig.scope` is a **separate field from `state`** and only accepts `ALL_USERS` via the
  API for either agent type.

**Consequence for the brief's requested `CREATE DESTINATION AGENT → KEEP DRAFT/UNPUBLISHED → APPLY
PERMISSIONS → APPLY SHARING → VALIDATE → APPROVAL → PUBLISH` chain:** "keep draft/unpublished" and
"publish" cannot be implemented as generic, agent-type-agnostic API calls. They must be redefined per
agent type:

```
Low-code path:
  CREATE (already, by construction, PRIVATE — "draft" already IS the created state, free)
    ↓
  APPLY PERMISSIONS / APPLY SHARING  — same ensureAgentAccess()/shareAgent() chain as today,
                                        but GATED behind approval (see below) instead of run
                                        automatically and immediately, as it does today
    ↓
  VALIDATE
    ↓
  APPROVAL
    ↓
  "PUBLISH" ⟺ calling shareAgent(ALL_USERS) for the first time (the only state-changing lever
              that exists) — NOT a state transition, a sharing-config transition. An agent that
              stays narrower-than-org-wide never has a "publish" moment at all; it simply
              accumulates per-principal agentUser grants after approval. Document this
              explicitly to the customer: "publish," for a low-code agent, means "share more
              broadly," not "make visible in a gallery" — gallery visibility for low-code
              agents on Standard/Plus is a separate, currently-unsolved platform limitation
              (docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md), unaffected by this lifecycle.

ADK path:
  DEPLOY the Reasoning Engine (agent_engines.create) — real compute exists, but the agent is
    NOT YET a Discovery Engine "Agent" resource and is NOT visible/queryable through the
    engine's gallery or agentUser IAM at all yet. This is the genuine "draft" state for ADK —
    achieved by DEFERRING the registration call, not by any draft flag.
    ↓
  APPLY PERMISSIONS / APPLY SHARING — pre-resolve identity/license/engine-role state so the
    moment of registration below can succeed immediately, without a second round-trip
    ↓
  VALIDATE (query the deployed-but-unregistered Reasoning Engine directly for smoke-testing,
    bypassing the Agent resource entirely — already possible since `deployReasoningEngine`
    without registration is this repo's own existing zero-quota-cost verification technique,
    per decisions.md 2026-08-05)
    ↓
  APPROVAL
    ↓
  "PUBLISH" ⟺ the `agents.create` registration call itself — THIS is the actual state-changing
              action for ADK (registration = state:ENABLED, immediately gallery-visible with
              sharingConfig:ALL_USERS by default). Approval must happen BEFORE this call, not
              after, because there is no way to un-register or narrow visibility once made.
```

**This is a real, non-trivial implementation change, not just a documentation update**: today's
orchestrator (`orchestrator.ts`, per the "ADK-first" decision in `decisions.md` 2026-08-05) deploys
*and* registers an ADK agent in one pass, with sharing applied immediately after. Building the
brief's requested approval gate for the ADK path specifically requires **splitting "deploy" from
"register" into two separately-schedulable orchestrator steps**, with the registration step gated on
an external approval signal — this is new work, correctly scoped by the brief's request but not
something this document is authorizing as already-decided (§24).

**Failure states (brief §13), mapped onto this corrected model:**

| Brief's failure state | Where it fires |
|---|---|
| `MAPPING_CONFLICT` | Two source mechanisms resolve to conflicting canonical permissions for the same principal on the same agent (e.g., listed as both Editor and Analytics Viewer) — record in `permissionConflicts`, do not auto-resolve |
| `IDENTITY_NOT_FOUND` | `identityMap.ts` resolution returns `unmatched` |
| `ROLE_NOT_SUPPORTED` | Any row in §H classified `NO_EQUIVALENT`/`NOT_MIGRATABLE` |
| `SHARING_NOT_SUPPORTED` | Attempting anything other than `ALL_USERS` via the Agent API, or attempting to narrow an already-registered ADK agent |
| `PERMISSION_FAILED` | Any of the 3 `ensureAgentAccess()` layers fails for a principal — name which layer, per `PrincipalAccessPrecheck` (already shipped) |
| `VALIDATION_FAILED` | `verify.ts` smoke test fails, or a new permission-specific validation (§L) fails |
| `PARTIAL_SUCCESS` | Some principals/agents succeed, others don't, within one run — already how `MigrationResult` per-agent reporting works; extend the same discipline to per-principal-within-an-agent |
| `MANUAL_REVIEW_REQUIRED` | Anything landing in `PermissionHandoff`/`permissionConflicts` |

**Retry/idempotency (brief §13's "must not duplicate permissions or broaden access"):** already
correctly designed for the parts that are shipped — `shareAgent(ALL_USERS)` is a PATCH to the same
value (idempotent no-op on retry); `grantAgentAccess()`/`ensureAgentAccess()` already do
read-then-diff-then-write against the live IAM policy (GET, merge, only add the delta, per
`PERMISSION-MAPPING-ARCHITECTURE.md` §3 and independently confirmed as matching the legacy Java
diff-before-write pattern in Part 2 §4) — a retry cannot double-grant or accidentally add a role that
wasn't computed this time, because the merge only ever adds what the *current* resolution says
should be there. **What retry must NOT do, and is not yet explicitly guarded against**: if a retry's
freshly-recomputed `PermissionResolution` is *narrower* than what was previously granted (e.g. a
source share was revoked between runs), the current design has no step that *removes* the
now-excess destination grant — it only ever adds. This is a real, currently-undesigned gap for the
"never broaden, and also don't leave stale over-grants behind" half of the brief's requirement.
Recommend: the diff step should compute both an add-set and a remove-set relative to the last
recorded `permissionAuditLog` state, and removal should require the same explicit-approval discipline
as any other grant change — never silently revoke either, since an admin may have manually widened
access on the destination for a reason this tool doesn't know about.

---

## §L. Deliverable 16 — Validation engine (brief §16)

A **new, permission-specific validation pass**, layered on top of (not replacing) the existing
`verify.ts` agent smoke-test:

```
validatePermissions(agent, resolution, destinationState) → ValidationReport

Environment/project level:
  - resolved project/engine matches the customer's confirmed environmentMap entry
  - each proposed env-role grant (Admin/Maker) has been explicitly approved (not just recommended)
  - no proposed grant duplicates an already-present binding (idempotency pre-check)

Agent level:
  - owner recorded (even if unresolvable — must be present as "unresolved," never silently absent)
  - every 'editor'/'agent-viewer' studioShareRole has a corresponding needs-review note — a
    MISSING note here (not the grant itself) is the actual failure condition, since none of these
    have a destination equivalent to apply
  - sharingConfig matches the intended plan (ALL_USERS iff source was org-wide; otherwise NOT
    ALL_USERS unless allowOvershare was explicitly set)
  - every principal in the "should have access" set has succeeded on ALL 3 destination layers,
    per PrincipalAccessPrecheck — a principal missing even one layer is a FAILED/WARNING row

Identity level:
  - every sharedPrincipal/chatAccess group resolved to a destination principal, an explicit
    override, or an explicit unresolved-with-reason — no silent gaps
  - external principals flagged (once isExternal ships) get an explicit WARNING even if resolved

Security level (the Least-Privilege Guard, §M, is what PRODUCES these facts; this engine checks them):
  - no principal received a role broader than its canonical permission implies
  - sharingConfig is not ALL_USERS unless justified by source org-wide policy or explicit
    allowOvershare acknowledgment
  - no project-level role was granted to "solve" a per-agent gap (co-author/analytics/evaluation)

Report levels (brief's exact vocabulary): PASS | WARNING | CONFLICT | MANUAL_REVIEW | FAILED
  PASS            — every check above holds
  WARNING         — e.g. an external principal resolved successfully but should be flagged
  CONFLICT        — a permissionConflicts row exists for this agent/principal
  MANUAL_REVIEW   — any NO_EQUIVALENT/NOT_MIGRATABLE row from §H, or an unresolved identity
  FAILED          — a destination-layer grant call itself errored (not just "no equivalent")
```

This validation must run **before** the APPROVAL gate in §K, and its report is exactly what
`migrationApprovals.resolvedPlanSnapshot` should be built from — an approver reviews a validation
report, not raw IAM call logs.

---

## §M. Deliverable 17 — Least-privilege safeguards ("Least Privilege Guard", brief §14)

Restating what's already encoded as non-negotiable (not new), plus what's genuinely new:

**Already shipped/decided, confirmed still correct by this pass:**
1. Never auto-grant a project-wide editor/admin role to compensate for a missing per-agent editor
   tier (`identityMap.ts:243`). §H's mapping matrix (row: Editor → NO_EQUIVALENT) is the concrete
   enforcement point.
2. Engine-level IAM preferred over project-level for `agentspaceUser` — smallest blast radius,
   already the shipped default.
3. `allowOvershare` defaults `false` — narrower-than-org-wide source access never silently becomes
   `ALL_USERS`.
4. Admin/Maker environment-role grants: one-at-a-time-confirmed (Admin) / bulk-reviewable-with-
   consent (Maker), never silent, never bulk-automatic for Admin.

**New, proposed by this document, not yet built:**
5. **Disabled-source-principal filter** (§G) — don't propagate access for an account that can't even
   sign in on the source.
6. **Symmetric remove-set computation on retry** (§K) — a Least Privilege Guard that only ever adds
   is incomplete; it must also detect and (with the same approval discipline as an add) flag
   over-grants left over from a narrower re-resolution.
7. **A hard pre-flight check before the `PUBLISH`/registration step specifically for ADK agents**
   (§K): because ADK registration is irreversible (no un-register, no narrowing after), the
   orchestrator must refuse to call `agents.create` for an ADK agent unless `VALIDATE` returned
   `PASS` or an explicit `WARNING`-with-acknowledgment — never on `CONFLICT`/`MANUAL_REVIEW`/`FAILED`.
   This is a harder gate than the low-code path needs (where a bad grant can at least be corrected
   after the fact via a diff-and-retry), precisely because the platform gives no undo for ADK
   registration.
8. **Default-public destination agents**: since `ALL_USERS` is the *only* value the API accepts for
   `sharingConfig`, any agent an operator creates via a path that doesn't explicitly call
   `shareAgent()` at all should default to **no sharing call made** (agent stays whatever the create
   response's default is, currently `ALL_USERS` per `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`'s recorded
   agent fields) — meaning **the platform's own create-time default is already "public to everyone
   with access to the engine," not private.** This is a significant, easy-to-miss risk: unlike
   low-code's `state` (which defaults private), `sharingConfig` does **not** default narrow. A
   Least-Privilege Guard must treat "did we explicitly decide sharing for this agent" as a required
   gate before `CREATE_DRAFT` is considered complete, not an optional follow-up step — creating an
   agent and forgetting to call the narrowing logic is not a safe default here, it is a silent
   over-share by omission.

---

## §N. Deliverable 21 (of the 25-item list) — Permission drift detection (brief §15)

**Recommendation: build this as an extension of the existing content-drift mechanism, not a new
subsystem — and treat it as a near-term follow-up, not a "later phase" to defer indefinitely, given
how directly it serves the brief's own security requirement (§14/§M).**

`driftDetector.ts` (existing) already snapshots agent content (instructions, knowledge sources,
capabilities) and explicitly excludes anything permission-related. Proposed extension: add a
permission-facts hash to the tracked snapshot (`AgentIR.permissions.chatAccess.policy` +
`sharedPrincipals` grouped by `studioShareRole`), so a re-run where the **source** permissions changed
is flagged for re-evaluation, even if agent content is unchanged (today it would short-circuit before
ever re-reading permissions).

**Destination-side drift** (the brief's own example: source says Editor, destination shows Viewer) is
a **different, arguably more urgent problem than source-drift** — it means the destination diverged
from what this tool last applied, likely because a Gemini admin changed something by hand in the
console. Answering it requires comparing `permissionAuditLog`'s last-applied-state against a fresh
`getIamPolicy` read at drift-check time. This is genuinely new work (no destination re-read for drift
purposes exists anywhere today) and should be scoped as:
- **Phase 1 (near-term, low cost):** source-side drift only, piggybacking on the existing
  `driftDetector.ts` re-run path — no new API calls to Gemini, just a wider snapshot hash.
- **Phase 2 (separate decision, real cost):** a scheduled or on-demand destination-side drift check
  that re-reads `getIamPolicy` for every managed agent/engine and diffs against `permissionAuditLog`
  — this has real Discovery Engine read-quota cost at scale and should be an explicit, customer-
  facing feature ("permission drift monitoring"), not a silent background job. Needs product sign-off
  on frequency/cost trade-offs before design goes further.

---

## §O. Deliverable 20 — Audit model (brief §20)

Directly satisfied by `permissionAuditLog` (§J) — one append-only row per (principal, agent,
destination-layer) grant decision, carrying exactly the chain the brief's own example asks for:
source principal/permission/resource → mapping rule → destination principal/permission/resource →
applied-by/at → validation result. The brief's worked example ("why does John have Editor access on
Sales Assistant") is answered by querying `permissionAuditLog` filtered on `principal.email` and
`sourceId`, returning every row in chronological order — which is precisely why the log must be
append-only rather than a current-state cache like `resolvedPrincipalCache`.

---

## §P. Deliverables 13–15 — State machine, conflict model, retry/idempotency

Covered in full in §K (state machine + failure states + retry semantics) and §J
(`permissionConflicts` schema). Not repeated here to avoid duplication; cross-referenced per the
brief's own numbering for completeness of the 25-item list.

---

## §Q. Deliverable 19 (service architecture) — brief §17/§18

**Recommendation: keep the current shape — do not split into separate Permission
Service/Sharing Service/Publication Service/Approval Service microservices.** The brief's diagram
(Dashboard → Orchestrator → {Discovery, Identity Mapper, Agent Migrator} → Permission Engine →
Sharing Engine → Validation Engine → Approval Engine → Publication Engine) is a reasonable
**conceptual** decomposition but should not be built as separate deployable services, for reasons
consistent with this repo's existing layering:

- Every "Engine" in the brief's diagram already has a direct, focused-file counterpart in
  `services/`: `identityMap.ts` (Identity Mapper), `gemini.ts`'s `ensureAgentAccess()`/
  `grantAgentAccess()`/`shareAgent()` (Permission + Sharing Engine), `verify.ts` plus the new §L
  logic (Validation Engine), `orchestrator.ts` (the orchestrator itself). This is already a
  service-per-concern split at the **file** level, which is this codebase's established granularity
  (`mapper.ts`, `topicCompiler.ts`, `knowledgeClassifier.ts` are all separately-organized single
  concerns within one deployable, not separate services).
- A dedicated **Approval Engine** is the one piece that's genuinely new (§K) — but it is new
  *functionality* (a gate + a `migrationApprovals` collection + an API endpoint), not evidence that
  it needs its own service process. Build it as `services/permissionApproval.ts` + a route, same
  pattern as everything else.
- A dedicated **Publication Engine** as a literal separate service would be solving a problem the
  destination platform doesn't have in the generic form the brief's diagram implies (§B.1, §K) — a
  service built around a "publish" primitive that doesn't exist uniformly across agent types would
  need to immediately special-case by agent type internally anyway, which is exactly what a plain
  `services/publication.ts` module already does without the overhead of a service boundary. This
  matches `decisions.md`'s own precedent (2026-08-04: reject a generalized abstraction until "a
  third deployment path actually materializes").
- **When would a real service split be justified?** If `EnvironmentIR`'s recommend/confirm workflow
  (still unbuilt) grows its own significant routing/approval/notification surface independent of the
  main migration run lifecycle, *that* would be the natural trigger — still not a "microservice" in
  the network-boundary sense, just a new focused module, consistent with how this whole codebase is
  organized (a monolith with clean internal layering, not a distributed system).

---

## §R. Deliverable 22 — Enterprise-scale considerations

- **Principal-level caching (`resolvedPrincipalCache`) is the primary scale lever already built** —
  without it, a customer with 5,000 users each shared across an average of 10 agents would trigger
  50,000 license/engine-role checks instead of 5,000. This is not new work; it's already shipped and
  is the correct answer to "thousands of users, groups, environments, and agents."
- **`permissionAuditLog` at scale needs compaction/retention policy** — append-only logs grow
  unboundedly; recommend a retention window (e.g., keep full detail 90 days, roll up to summary
  counts beyond that) as a follow-up product decision, not designed further here since no retention
  requirement has been stated.
- **`environmentAccessSnapshots`' "one query per environment, not per bot" design is unverified at
  large-tenant scale** — already flagged as an open risk in `permission-mapping.md` Part 2 (a
  `systemuserroles` scan at a large environment could be a real volume concern) — carried forward,
  not resolved here.
- **Bounded concurrency, not new fan-out** — every new call this design adds (validation reads,
  audit-log writes, conflict checks) must go through the existing `mapPool` discipline and the
  existing Discovery Engine write-quota backoff (`services/rateLimiter.ts`), never a new unbounded
  loop over principals or agents.

---

## §S. Deliverable 23 — Failure scenarios

| Scenario | Handling |
|---|---|
| Mongo down mid-run | Every new collection in §J follows the existing best-effort (`isDbConnected()` guard) pattern — the run still completes; `permissionAuditLog` writes degrade to "not recorded" with a warning, never block the migration |
| Gemini license API quota exhausted | Existing `LicenseState = 'capacity_exhausted'` (shipped) — named failure, `needs-review`, never silently treated as "licensed" |
| ADK registration succeeds but a post-registration IAM/license grant fails | Because registration is irreversible (§K/§M), this is the worst-case failure mode — the agent is already `ENABLED`+`ALL_USERS` and cannot be pulled back. The Least-Privilege Guard (§M item 7) exists specifically to prevent reaching this state with unresolved principals; if it happens anyway, report it as a **security-relevant incident**, not a routine `needs-review` note — recommend a distinct `FidelityNote`/report severity for "agent went live more broadly than intended" versus ordinary partial-mapping notes |
| Customer rejects an approval | `migrationApprovals.status = 'rejected'` — the low-code agent stays PRIVATE (no-op, safe); an ADK agent must not have been registered yet (§K enforces registration only after approval) — rejection is always safe on both paths precisely because registration is deferred |
| Identity resolution service (Graph/Directory) unreachable | Falls back to override-map-only + email-heuristic, more `unmatched` entries surfaced honestly — matches existing `identityMap.ts` degradation behavior |
| A principal's source role changes between EXTRACT and INSERT (long-running migration) | Not explicitly handled today — `AgentIR.permissions` is captured once at EXTRACT and staged; if INSERT runs much later, it acts on a snapshot. Flag as an open question (§25): should a stale permissions snapshot trigger a re-extract before applying, past some age threshold? |

---

## §T. Deliverable 24 — Example end-to-end migration

```
1. DISCOVER   — enumerate "Sales Production" environment: 12 agents, 40 topics (existing scope.ts)
2. ASSESS     — existing assess.ts + AgentPermissions capture for each agent (existing dataverse.ts)
                → "Sales Assistant" agent: owner=Sales Team, sharedPrincipals=[Jane (editor),
                  Priya (agent-viewer)], chatAccess={policy:'group', groupIds:['SalesReaders']}
3. MAP        — mapper.ts (unchanged; agent content, not permissions)
4. IDENTITY NORMALIZATION — identityMap.ts resolves Jane→jane@customer.com (email-match),
                Priya→unmatched (external contractor, no owned-domain match, no override),
                SalesReaders(Entra group)→sales-readers@customer.com (override map hit)
5. CANONICAL PERMISSION MODEL — Jane: co-author (NO_EQUIVALENT); Priya: evaluation-view
                (NO_EQUIVALENT, also unresolved identity); SalesReaders: chat-use, scoped (PARTIAL)
6. CREATE DRAFT — low-code agent created (state:PRIVATE by construction) — no sharing call made yet
7. VALIDATE (pre-approval) — §L report: WARNING (Jane's co-author has no equivalent, correctly
                flagged, not silently dropped), MANUAL_REVIEW (Priya unresolved AND no equivalent
                even if resolved), CONFLICT: none
8. APPROVAL   — admin reviews the report, approves proceeding with SalesReaders chat access only;
                acknowledges Jane/Priya as manual, out-of-band follow-ups
9. APPLY PERMISSIONS/SHARING — ensureAgentAccess() 3-layer chain run for each SalesReaders member
                resolved to a Google identity; PermissionHandoff generated for Jane/Priya
10. VALIDATE (post-apply) — confirm all 3 layers succeeded for each granted principal
11. PUBLISH   — for this agent, "publish" = no ALL_USERS call was ever made (source was
                group-restricted, not org-wide) — the agent remains reachable only by the
                specific principals granted in step 9, which is the correct, honest outcome
12. REPORT    — per-agent fidelity report shows: chat access mapped (partial, per-principal);
                co-author access: needs-review, manual steps named; evaluation access: needs-review,
                unresolved identity named; nothing silently dropped, nothing silently over-shared
```

---

## §U. Deliverable 25 — Recommended implementation phases

1. **Phase 0 (already shipped):** `AgentIR.permissions`, `identityMap.ts`, `identityMappings`,
   `resolvedPrincipalCache`, `ensureAgentAccess()`'s 3-layer chain. No new work.
2. **Phase 1 — Validation + audit (low risk, high value, no destination-behavior change):**
   `permissionAuditLog` (append-only), the §L validation engine, `permissionConflicts`. Ships
   visibility without changing what gets granted.
3. **Phase 2 — Least-privilege hardening (small, behavior-narrowing, needs product sign-off on
   defaults):** disabled-principal filter (§G), symmetric remove-set on retry (§K), the mandatory
   pre-registration gate for ADK (§M item 7).
4. **Phase 3 — Draft-before-publish / approval gate (the brief's core ask, real orchestrator
   surgery):** split ADK deploy-from-register (§K), `migrationApprovals`, an approval API/UI surface,
   `permissionMigrationMode` (design-only today) wired to actually gate the SHARING sub-state.
   **This phase requires a product/CEO decision** on the default mode, per the existing
   decision-log entry.
5. **Phase 4 — Environment-role recommend/confirm (already scoped, unbuilt):** `EnvironmentIR`,
   `environmentAccessSnapshots`, the SelectMap panel for Admin/Maker recommendations.
6. **Phase 5 — Drift detection (source-side first, destination-side as a distinct, cost-aware
   follow-up):** per §N's two-part phasing.
7. **Deferred, not scheduled, pending real customer evidence:** one-source-user-to-many-destination-
   identities, nested-group flattening, `aiplatform.reasoningEngines.query`-based ADK narrowing
   (pending the §D diagnostic spike).

---

## §V. Deliverable/Brief §21 — Critical self-review of the brief's design (explicit, adversarial, as requested)

**Correct assumptions:**
- Environment-level and agent-level access are genuinely different axes (source and destination
  both, §D).
- The overall SOURCE→IDENTITY→CANONICAL→DESTINATION→VALIDATION→APPROVAL→PUBLICATION shape (§C).
- Permission migration should be conceptually separable from agent-content migration (§B.2) — the
  *principle*, not the specific "one central collection" or "always first-class" implementations.
- Identity mapping needs an explicit, overridable map, not a pure heuristic (§G) — already built.
- The instinct that publishing-by-default is wrong for an enterprise tool (§B.2, §M item 8) — correct,
  and this pass found the platform's actual default (`sharingConfig` defaults to `ALL_USERS`
  server-side!) makes this *more* urgent than the brief may have realized, not less.

**Incorrect assumptions:**
- Destination role names (`Discovery Engine Editor`/`Viewer`) don't exist verbatim — real roles are
  `agentspace`-prefixed and grain-specific (§D).
- A draft→publish state machine as a single, agent-type-agnostic mechanism doesn't exist on the
  destination — it must be redefined per agent type (§K), and for low-code agents specifically,
  "publish" as the brief imagines it (make visible) **cannot be built at all**, gallery-visibility-
  wise; only the sharing-scope lever exists.
- Treating "permissions should be first-class" as a blanket rule rather than a per-data-type test
  (N:1 vs 1:1 relationship to agents) — the brief's own stated reasons for wanting first-class status
  (caching, audit, retries) are already satisfied by the narrower, already-shipped split (§E).
- The three-mechanism source model (End User/Agent Viewer/Editor) undercounts — Analytics Viewer is
  a fourth, distinct mechanism (§D).

**Dangerous assumptions, if implemented as literally proposed:**
- Reusing the legacy `PermissionQueue` shape (§J) — would import file-sharing semantics into an
  IAM-grant domain and miss fields this domain actually needs (per-layer failure attribution,
  canonical permission, principal type).
- The single giant nested `migrationId` document (§J) — a real scalability and contention risk at
  the brief's own stated target scale, and inconsistent with how this exact repo already solved the
  same problem (`stagedAgents`, one row per agent).
- Assuming retry only needs to guard against *duplicating* grants — it also needs to guard against
  *leaving stale over-grants behind* when a re-resolution is narrower (§K); the brief's retry
  requirement ("must not duplicate or accidentally broaden") doesn't ask about this shrink case at
  all, and it's a real gap in every version of this design to date, including the ones already
  shipped.

**Missing concepts (not present anywhere in the brief):**
- The platform-level fact that Gemini's own agent creation defaults to `sharingConfig: ALL_USERS`
  (not private) — a Least-Privilege Guard must treat "sharing was explicitly decided" as a required
  gate, not an optional add-on (§M item 8). This is arguably the single most safety-critical fact in
  this whole document and it isn't in the brief at all.
- Disabled/deactivated source principals as a filter step before identity resolution (§G).
- The asymmetry between low-code (reversible — can always re-diff and re-grant) and ADK
  (irreversible at registration) agents, which should drive materially different approval-strictness
  for the two paths (§M item 7).

**Permission mappings that are NOT 1:1:** every row in §H marked PARTIAL, APPROXIMATE, or
REQUIRES_MANUAL_REVIEW — most centrally, "group chat share" (console supports native group grants;
API can only reach a flattened per-principal list).

**Source permissions with no destination equivalent:** collaborative authoring/Editor, Analytics
Viewer, Agent Viewer/Evaluations, granular `AccessRights` (Append/AppendTo/Assign/Delete), and every
environment role except Basic User (§H).

**Destination permissions with no source equivalent:** the Gemini Enterprise **per-user license**
axis has no Copilot Studio counterpart at all — Copilot licensing is seat-based at the Microsoft 365/
Power Platform tier and isn't something this pipeline's source model tracks as a sharing mechanism;
it must be surfaced as a **new destination-side precondition**, not mapped from anything on the
source (already correctly handled as its own layer in `ensureAgentAccess()`, just worth stating
explicitly as "destination-only," per the brief's own request in §23 to name every asymmetry in both
directions).

**Cases requiring manual administrator approval:** every `NO_EQUIVALENT`/`NOT_MIGRATABLE` row in §H;
every unresolved identity; every System-Administrator-role recommendation (always, never bulk); every
ADK registration (§M item 7, because it's irreversible); any retry that would shrink a
previously-granted destination permission (§K).

---

## §W. Decisions requiring explicit sign-off before implementation

Per `.claude/rules/architecture-boundaries.md`, none of the following are approved by this document:

1. `EnvironmentIR` + `environmentAccessSnapshots` (carried forward, design-only).
2. `PrincipalRef.isExternal`/`isExternalConfidence` (carried forward, design-only).
3. `permissionMigrationMode` and its recommended `'report-only'` default — **needs product/CEO
   review**, per the existing decision log, because it narrows current default behavior.
4. `studioShareRole` expansion — blocked on the still-outstanding live-tenant diagnostic spike
   (§D).
5. A diagnostic spike to confirm/reject `aiplatform.reasoningEngines.query` (§D) before any mapping-
   matrix row references it as buildable.
6. **New in this document:** the full draft-before-publish/approval architecture (§K) — real
   orchestrator surgery (splitting ADK deploy-from-register), a new `migrationApprovals` collection,
   and a new approval API/UI surface. This is the brief's central request and the largest net-new
   piece of work in this document; it needs its own focused Architect design pass plus product
   sign-off on the default `permissionMigrationMode`, not a blanket approval bundled with everything
   else here.
7. **New in this document:** `permissionConflicts` and `permissionAuditLog` collections (§J).
8. **New in this document:** the symmetric remove-set retry logic (§K) — touches an existing,
   already-shipped, security-sensitive code path (`grantAgentAccess`/`ensureAgentAccess`) and should
   get a `/cso` security pass in addition to Architect sign-off given it's a revocation mechanism.
9. **New in this document:** extending `driftDetector.ts` for permission drift (§N), Phase 1
   (source-side) only — Phase 2 (destination-side) needs a separate product decision on cost/
   frequency first.

None of these are blocking for continuing to operate the currently-shipped Part 1 + Part 2 §3
behavior (extraction, identity resolution, license/engine/agent-role chain) as-is.

---

## §X. Open questions needing a live-tenant confirmation or a human product decision

1. (Carried forward) Does Analytics/Evaluation sharing leave any row-share signal extraction can see
   at all? (`permission-mapping.md` §2.1)
2. (Carried forward) Are the exact REST paths/permission strings for the license and engine-role
   calls confirmed against a live tenant, not just a doc fetch? (`PERMISSION-MAPPING-ARCHITECTURE.md` §3.1)
3. Is `aiplatform.reasoningEngines.query` on the backing Reasoning Engine real and usable for
   narrowing ADK agent access? (§D)
4. Does the Agent Viewer (evaluations) share dialog's "add a group" UI actually produce a
   group-scoped, enumerable grant? (§D)
5. (Carried forward) Should `permissionMigrationMode` default to `'report-only'`? Product/CEO
   decision.
6. Should multi-environment-into-one-project mappings require explicit customer acknowledgment of
   shared IAM blast radius? (§F)
7. **New:** is one-source-user-to-many-destination-identities a real customer need, or should it stay
   explicitly unsupported? (§G)
8. **New:** what retention window should `permissionAuditLog` use at enterprise scale? (§R)
9. **New:** should a stale (long-since-extracted) permissions snapshot force a re-extract before
   INSERT applies it, past some age threshold? (§S)

---

## Sources

- [Share agents with other users – Microsoft Copilot Studio](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots) (Microsoft Learn, updated 2026-08-03) — source hierarchy verification, §D
- [docs.cloud.google.com/gemini-enterprise-agent-platform/govern/share-agent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/govern/share-agent) — fetched excerpt, **unconfirmed claim flagged in §D**, needs a live diagnostic spike before being trusted
- [docs.cloud.google.com/gemini/enterprise/docs/share-custom-agents](https://docs.cloud.google.com/gemini/enterprise/docs/share-custom-agents) — fetched excerpt, consistent with existing internal findings
- [docs.cloud.google.com/gemini/enterprise/docs/reference/rest/v1alpha/projects.locations.collections.engines.assistants.agents](https://docs.cloud.google.com/gemini/enterprise/docs/reference/rest/v1alpha/projects.locations.collections.engines.assistants.agents) — fetched excerpt, consistent with `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`'s independent live testing
- `docs/design/permission-mapping.md`, `docs/design/PERMISSION-MAPPING-ARCHITECTURE.md`,
  `docs/design/environment-and-agent-permission-mapping-plan.md`,
  `docs/design/multi-account-gemini.md`, `docs/GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` (this repo, prior
  sessions — internal, cited and reconciled against throughout)
- `server/src/types.ts`, `server/src/db/repos/*.ts` (read directly to confirm what is actually
  shipped vs. design-only before writing this document)