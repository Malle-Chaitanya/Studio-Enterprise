# Design: Permission Mapping (Copilot Studio → Gemini Enterprise)

**Status:** Proposed (needs Architect sign-off — this changes the `AgentIR` contract)
**Author:** Architect agent
**Audience:** implementer + reviewer. Precise on shapes/APIs; plain-English on the "why".
**Pipeline stages touched:** EXTRACT (dataverse), IR contract (types), a new identity-map
service, INSERT (mapper + orchestrator handoff), REPORT.

---

## Summary

Copilot Studio agents carry access information — who owns the agent, who can co-author it,
and who is allowed to chat with it. Today CS_GE drops all of that: every migrated Gemini
agent is shared org-wide (`sharingConfig.scope = ALL_USERS`) regardless of the source's
narrower access. This design captures the source permissions **losslessly** into a new
`AgentIR.permissions` block during EXTRACT, maps Microsoft principals to Google Workspace
principals in a new pure service, and — because **Gemini has no API to apply per-user/
per-group agent sharing today** — turns anything narrower than org-wide into an honest,
per-agent **"permission handoff"** (mapped Google users/groups + exact console steps) plus a
`FidelityNote(needs-review)`. Nothing is silently dropped or silently over-shared.

The single most important fact shaping this design: **automated per-principal agent sharing
is not buildable against the Gemini API today.** So we do not pretend to. We extract truthfully,
recommend precisely, and hand the customer a checklist — exactly the pattern the product already
uses for owner-substitution and unsupported knowledge sources.

---

## Architecture

### Components & data flow

```
EXTRACT (app-only, Dataverse)                    INSERT (SA, Gemini)
─────────────────────────────                    ───────────────────
extractAgent()                                   orchestrator Phase 2
  └─ readAgentPermissions()  ──┐                    └─ resolvePermissionPlan()
       (dataverse.ts)          │                         (mapper / new helper)
                               ▼                            │
                    AgentIR.permissions                     ├─ org-wide  → shareAgent(ALL_USERS)   [exists]
                               │                            └─ narrower  → PermissionHandoff        [new]
                       staged in Mongo                              + FidelityNote(needs-review)
                    (StagedAgent.permissions)                          │
                               │                                       ▼
                        identityMap service  ───────────────►  report.ts renders the plan
                    (Entra principal → Google principal)        (mapped / manual / impossible)
```

- **EXTRACT** (`services/dataverse.ts`): a new best-effort `readAgentPermissions(url, token, botId)`
  populates `AgentIR.permissions`. It uses the **same app-only token** already in use — no new
  scope, no Gemini calls. Slots into `extractAgent` right next to the existing `sourceMetadata`
  read (dataverse.ts ~line 500).
- **IR contract** (`types.ts`): a new optional `AgentIR.permissions` block. Optional = additive =
  backward-compatible (see below).
- **Identity map** (`services/identityMap.ts`, **new**): a pure-ish service consuming IR
  permissions + an org-scoped override map, producing resolved Google principals and a list of
  **unmatched** principals for the customer to decide on. No Express, no `req`/`res`.
- **INSERT** (`orchestrator.ts` Phase 2 + `mapper.ts`): decides org-wide vs handoff, calls the
  existing `shareAgent` only for the org-wide case, and records a `PermissionHandoff` +
  `FidelityNote` otherwise.
- **REPORT** (`report.ts`): renders the per-agent permission plan and a consolidated
  "Permissions to apply manually" section.

### Where it sits across the phase boundary

Cleanly on both sides, respecting the two-phase rule. EXTRACT **produces** `IR.permissions` and
never touches Gemini. INSERT **consumes** the staged permissions and never touches Dataverse for
this purpose (the app-only reads all happen in Phase 1). The staging DB remains the only handoff.
The identity-map service is invoked in Phase 2 from staged data — it is a pure transform over IR,
so it could equally run in Phase 1; we place its **apply/handoff decision** in Phase 2 because that
is where destination identities and the org profile are authoritative.

### AgentIR / DB-schema impact

- **AgentIR shape change: YES.** New optional `AgentIR.permissions`. This is a first-class
  architectural decision requiring Architect sign-off + a `decisions.md` entry (drafted below).
- **DB-schema change: YES, additive.** `StagedAgent` gains an optional `permissions` field
  (the extracted block) and an optional `permissionPlan` field (the resolved plan for audit).
  Plus **one new collection**, `identityMappings`, `appUserId`-scoped, for the customer override
  map. No index on existing collections changes.

---

## 1. The `AgentIR.permissions` contract change

Add to `server/src/types.ts`. Every field is optional or defaulted so a pre-existing IR (no
permissions) stays valid — the block "rides along" exactly like `unmapped`/`sourceMetadata`.

```ts
/** A security principal on either side of the migration (platform-neutral). */
export interface PrincipalRef {
  type: 'user' | 'team' | 'group';
  /** Source id: Dataverse systemuserid / teamid, or Entra group objectId. */
  id: string;
  /** Primary email / UPN when resolvable — the join key for identity mapping. */
  email?: string;
  displayName?: string;
}

/** A principal that has been granted explicit rights on the source agent (a share). */
export interface SharedPrincipal extends PrincipalRef {
  /**
   * Dataverse AccessRights, decoded from the bitmask into stable string tokens:
   * 'Read' | 'Write' | 'Append' | 'AppendTo' | 'Share' | 'Assign' | 'Delete'.
   * Preserved verbatim — the mapper interprets, extraction never editorializes.
   */
  rights: string[];
  /**
   * Convenience roll-up the mapper/report can switch on without re-decoding the
   * bitmask. 'coauthor' ≈ Read+Write+Append+AppendTo+Share (and the Environment
   * Maker role, which is NOT a record share — see chatAccess note). 'viewer' ≈
   * Read only. 'custom' = anything else (surfaced verbatim).
   */
  roleHint?: 'coauthor' | 'viewer' | 'custom';
}

/**
 * End-user CHAT access — a SEPARATE surface from record sharing. Lives on the
 * bot row itself (accesscontrolpolicy + authorizedsecuritygroupids), governs who
 * may talk to the agent, and is the field that actually maps to Gemini sharing.
 */
export interface ChatAccess {
  /**
   * Decoded from bot.accesscontrolpolicy:
   *   'any'            (0) → anyone in the org can chat        → maps to ALL_USERS
   *   'copilot-readers'(1) → users with Copilot read access
   *   'group'          (2) → only members of authorizedsecuritygroupids
   *   'any-multitenant'(3) → any, cross-tenant
   * Kept as a decoded string so downstream never re-parses the enum.
   */
  policy: 'any' | 'copilot-readers' | 'group' | 'any-multitenant' | 'unknown';
  /** Raw numeric policy, preserved for audit/lossless honesty. */
  policyCode?: number;
  /** Up to 20 Entra security group objectIds (when policy = 'group'). */
  groupIds: string[];
}

/**
 * Source access model for an agent. Additive & optional — absent on IRs
 * extracted before this feature, or when the app user lacks rights to read
 * shares (degrades gracefully; see `readError`).
 */
export interface AgentPermissions {
  /** The bot's ownerid — a systemuser OR a team (Copilot auto-creates an owner team). */
  owner?: PrincipalRef;
  /** Explicit record shares (co-authors/editors/viewers) from RetrieveSharedPrincipalsAndAccess. */
  sharedPrincipals: SharedPrincipal[];
  /** End-user chat access (the surface that actually maps to Gemini sharing). */
  chatAccess?: ChatAccess;
  /**
   * Set when we could read the bot row but NOT its shares (app user lacks the
   * Share/Read privilege on the record). Honest degradation, never a hard fail —
   * surfaces as a needs-review note rather than a fabricated empty share list.
   */
  readError?: string;
}
```

Then on `AgentIR`:

```ts
export interface AgentIR {
  // ...existing fields...
  /** Source access model (owner, shares, chat access). Optional/additive. */
  permissions?: AgentPermissions;
}
```

**Backward-compatibility statement (required by the boundary rule):** the change is purely
additive — one new optional field on `AgentIR` plus new interfaces. No existing field changes
type or meaning. Every current call site that builds an `AgentIR` (only `extractAgent`) continues
to type-check without touching `permissions`. Already-staged rows and cached IRs deserialize
unchanged (`permissions` is simply `undefined`). This satisfies "unmapped fields ride along"
and keeps the IR lossless.

**Needs Architect sign-off + `decisions.md` entry** — drafted in Notes.

---

## 2. Extraction design (EXTRACT phase, `services/dataverse.ts`, app-only)

All calls use the **existing app-only `client_credentials` token** already threaded into
`extractAgent(url, token, bot)`. No new scope (adding a delegated Dynamics scope would trigger
`AADSTS65001` — see security-rules). No Gemini calls (phase boundary).

### Exact Web API calls

1. **Owner + chat access (one read, extends the existing `sourceMetadata` select):**
   ```
   GET {url}/api/data/v9.2/bots({botId})
       ?$select=_ownerid_value,accesscontrolpolicy,authorizedsecuritygroupids
   ```
   - `_ownerid_value` + the `OData.Community.Display.V1.FormattedValue` / lookup annotations give
     owner id; a follow-up `$expand=ownerid` (or a lightweight `systemusers`/`teams` lookup by id)
     resolves `email` + `displayName`. Owner type (user vs team) comes from the
     `Microsoft.Dynamics.CRM.lookuplogicalname` annotation on `_ownerid_value`.
   - `accesscontrolpolicy` → `ChatAccess.policy` (decode 0/1/2/3).
   - `authorizedsecuritygroupids` → `ChatAccess.groupIds` (parse the stored id list).

2. **Explicit shares (bound function on the bot record):**
   ```
   GET {url}/api/data/v9.2/bots({botId})/Microsoft.Dynamics.CRM.RetrieveSharedPrincipalsAndAccess()
   ```
   Returns `PrincipalAccess[]` — each `{ Principal: {id, logicalname}, AccessMask }`. Decode
   `AccessMask` (comma/flag string like `"ReadAccess, WriteAccess, ..."` or a bitmask depending on
   the org) into the stable `rights` tokens and compute `roleHint`.

3. **(Optional, per-principal effective access — only if a share row is ambiguous):**
   ```
   POST {url}/api/data/v9.2/bots({botId})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess
   body: { "Target": { "@odata.type": "...", "botid": "{botId}" }, "Principal": {...} }
   ```
   Not needed for the common path; keep as a documented fallback, not wired in P1.

4. **Resolve principal emails for group ids (chat-access groups are Entra objects, not Dataverse):**
   `authorizedsecuritygroupids` are **Entra** group objectIds. Email/displayName resolution for
   those happens later against **Microsoft Graph** in the identity-map service (it already has a
   Graph-capable path via `auth/microsoft.ts`), NOT in the Dataverse extractor. Extraction stores
   the raw objectIds losslessly; resolution is the identity map's job.

### Where it slots into `extractAgent`

Add a `readAgentPermissions(url, token, bot.botid)` helper and call it in the same best-effort
`try/catch` neighborhood as the existing `sourceMetadata` block (dataverse.ts ~line 500). Assign
its result to the new `permissions` field in the returned `AgentIR` (~line 632). It runs in the
same per-agent flow, inside the Phase-1 concurrency pool — no new fan-out pattern.

### Error / permission-degradation handling

Mirror the existing best-effort provenance read:
- Wrap the whole permissions read in `try/catch`; a failure sets `permissions` to a minimal block
  with `readError` populated and **never** blocks extraction (`logger.warn`, continue).
- Specifically distinguish "couldn't read shares" from "no shares": if the bot row reads but
  `RetrieveSharedPrincipalsAndAccess()` 403s (app user lacks `Share`/`Read` privilege on the
  record), set `permissions.readError = 'shares not readable (insufficient app-user privilege)'`
  and leave `sharedPrincipals: []`. Downstream turns `readError` into a `needs-review` note — we
  never present an empty share list as "no one has access", which would be a fidelity lie.
- Owner is usually readable even when shares aren't; capture whatever we can.

Follow the codebase's ASCII-safe logging and "never throw in best-effort paths" rules.

---

## 3. Identity-mapping service (`services/identityMap.ts`, new)

**Purpose (plain English):** a Copilot agent's owner/co-authors/chat-groups are *Microsoft*
identities (emails, UPNs, Entra group ids). To share the migrated agent with the *same people* in
Google, we need each Microsoft principal's matching *Google Workspace* identity. This service does
that translation and — critically — tells us who it **couldn't** match, so the customer can decide
(exactly like the existing "owner missing → pick a substitute" flow).

**Shape:** a pure-ish service consuming IR permissions + config/overrides; **no Express**, may call
Graph (via `auth/microsoft.ts`) to resolve group emails and may read the org profile. Keep the core
transform pure and testable (`mapper.ts`/`scope.ts` are the model — data in, data out).

### Mapping strategy (in priority order)

1. **Customer override map (highest priority).** An explicit `sourceEmail → googleEmail` (and
   `sourceGroupId → googleGroupEmail`) map the customer supplies. Wins over everything.
2. **Email match (default).** If the source principal's email/UPN domain is one of the org's
   **owned domains** (from `OrganizationProfile.ownedDomains`, already built once per run in the
   orchestrator), assume the same address exists in Google Workspace. This is the common tenant-
   consolidation case and matches how the org profile is already used.
3. **Group → group.** Entra security groups map to Google Identity groups by email (or via the
   override map). WIF `google.subject = email` is the federation path, but that is a customer IdP
   config concern, not something this service applies — the service resolves the **target group
   email** and records it; it does not configure federation.
4. **Unmatched → surfaced, never guessed.** Anything that resolves to nothing (no override, email
   domain not owned, unlicensed/absent user) goes into an `unmatched` list with a reason. These are
   presented to the customer for a decision — substitute, skip, or provide a mapping — mirroring the
   owner-substitution UX. We never fabricate a Google identity.

### Proposed interface

```ts
export interface ResolvedPrincipal {
  source: PrincipalRef;                 // the Microsoft side
  google?: { type: 'user' | 'group'; email: string }; // resolved target, if any
  via: 'override' | 'email-match' | 'group-match' | 'unmatched';
  reason?: string;                      // why unmatched / any caveat
}

export interface PermissionResolution {
  owner: ResolvedPrincipal | undefined;
  coauthors: ResolvedPrincipal[];       // from sharedPrincipals (roleHint 'coauthor')
  viewers: ResolvedPrincipal[];
  chatPrincipals: ResolvedPrincipal[];  // from chatAccess.groupIds (the ones that matter for sharing)
  unmatched: ResolvedPrincipal[];       // roll-up of everything via==='unmatched'
}

export function resolvePermissions(
  perms: AgentPermissions,
  ctx: { ownedDomains: string[]; overrides?: IdentityMap },
): PermissionResolution;
```

### Where the map is stored

A **new `appUserId`-scoped collection `identityMappings`** (one repo module,
`db/repos/identityMap.ts`; index `{ appUserId: 1, tenantId: 1 }` unique, added idempotently in
`db/mongo.ts` — this makes it "collection #10"). Rationale: the override map is durable, reused
across runs, and per-customer — session TTL (1 hour) is wrong for it. Shape:

```ts
interface IdentityMap {
  appUserId: string;                    // multi-tenant key (never client-supplied; from session)
  tenantId: string;
  users: Record<string, string>;        // sourceEmail/UPN → googleEmail
  groups: Record<string, string>;       // sourceGroupObjectId → googleGroupEmail
  updatedAt: Date;
}
```

Best-effort like every repo: `isDbConnected()` guard, returns an empty map if Mongo is down, so a
run still completes (falling back to email-match only, with more `unmatched` entries surfaced).

### Surfacing unmatched principals for a customer decision

The `unmatched` list flows into the report (Section 5) and can back a future UI review step
(SelectMap or a new "Permissions" panel). The decision options offered per unmatched principal
mirror the owner-substitution flow: **provide a mapping / substitute a different Google principal /
skip (accept the fidelity loss)**. The service just produces the honest list; the *decision* is the
customer's — the tool recommends, it does not silently decide.

---

## 4. Apply-or-handoff logic (INSERT phase, `orchestrator.ts` Phase 2 + `mapper.ts`)

The hard constraint: Gemini's agent API accepts **only** `sharingConfig.scope = ALL_USERS`.
`RESTRICTED`/per-principal values 400. Per-agent IAM doesn't exist. So the branch is binary:

```
resolvePermissionPlan(perms, resolution):
  if chatAccess.policy in {'any', 'any-multitenant'}:
      → APPLY: shareAgent(dest, saToken, agentId)   // existing ALL_USERS call, unchanged
        FidelityNote('sharing', 'mapped',
          'Source allowed org-wide chat access → shared with ALL_USERS.')
  else  // 'group' | 'copilot-readers' | 'unknown'  → narrower than org-wide
      → DO NOT call any sharing API with a non-ALL_USERS value (it 400s and would
        leave the agent in an inconsistent state).
      → EITHER leave the agent unshared (safe default: private to the creating
        identity), OR share ALL_USERS ONLY if the customer explicitly opts into
        "over-share is acceptable" (NOT the default — over-sharing is a trust
        failure per security-rules).
      → EMIT a PermissionHandoff (below) + FidelityNote('sharing', 'needs-review', ...).
```

### The `PermissionHandoff` object

A per-agent, machine-readable instruction set the report renders and (later) a UI can display.
Stored on the `StagedAgent` (`permissionPlan`) and echoed into the `MigrationResult` for the report.

```ts
export interface PermissionHandoff {
  agentName: string;
  geminiAgentId?: string;
  /** Why automation wasn't possible (the honest reason). */
  reason: string;                       // e.g. 'Gemini API has no per-user/group agent sharing'
  /** The resolved Google users to add via the console Share dialog. */
  grantUsers: string[];                 // emails
  /** The resolved Google groups to add. */
  grantGroups: string[];                // group emails
  /** Principals we could NOT map — customer must decide. */
  unresolved: { source: string; reason: string }[];
  /** Exact, copy-pasteable console steps. */
  steps: string[];
}
```

`steps` are concrete and match the two verified console surfaces:
1. **Owner "Share" dialog** (Agent Designer → open the agent → **Share** → add each `grantUsers`/
   `grantGroups` email → save).
2. **Admin "User permissions" tab** (for org-admin-driven grants).

### Owner-remap handling

The Gemini agent's owner follows the **creating identity** (SA via direct-IAM, or the impersonated
admin via DWD) — there is no settable owner field. So:
- If the source owner **maps** to a Google principal: record in the handoff "intended owner =
  `<googleEmail>`; add them via the Share dialog with edit rights (console-only)" and emit a
  `needs-review` note — we cannot set ownership via API.
- If the source owner has **no** Google match: this is the owner-substitution case. Surface it in
  `unresolved` with reason `'source owner has no Google match'` and route it through the same
  customer-decision flow (substitute / skip). Never invent an owner.

### Idempotency

- `shareAgent(ALL_USERS)` is already idempotent (a PATCH to the same value is a no-op).
- The handoff is **advisory data**, not a mutation — re-running regenerates the same handoff from
  the same staged permissions; it creates nothing in Gemini, so re-runs can never duplicate.

---

## 5. Reporting (`report.ts`)

The report must show the permission plan per agent and a consolidated action list — nothing
silently dropped. Two additions:

### Per-agent section (extend the existing `## <name>` block)

```
- Permissions:
  - Owner: <source owner> → <google owner | ⚠ no match — customer decision>
  - Chat access (source): group-restricted (2 groups)  →  NOT auto-shared (see handoff)
  - Fidelity: [needs-review] sharing — Gemini API can't apply per-group sharing; manual steps below.
```

Drive this off `MigrationResult.fidelity` (already rendered) plus a new optional
`MigrationResult.permissionHandoff?: PermissionHandoff`. The existing fidelity loop already prints
`needs-review` notes and the "Needs human review" roll-up, so the note flows through with **zero**
report changes; the handoff detail is the only new rendering.

### Consolidated "Permissions to apply manually" section

A new bottom section that buckets every agent into:
- **Auto-applied (org-wide):** shared `ALL_USERS` — done, nothing to do.
- **Manual (mapped):** handoff with resolved Google users/groups + console steps.
- **Manual (unresolved):** principals with no Google match — customer must map/substitute/skip.
- **Impossible today:** granular Dataverse right-levels (Append/AppendTo/Assign/Delete) and
  per-agent owner assignment — documented as out of scope with the reason (Section 8).

This mirrors the existing knowledge-source honesty: "auto-migrated vs recommended vs manual".

---

## 6. Phase boundary, idempotency, multi-tenant, Mongo-down

- **Phase boundary:** EXTRACT (`dataverse.ts`) produces `IR.permissions` using the app-only token,
  never calls Gemini. INSERT consumes staged permissions, never calls Dataverse for permissions.
  Staging DB stays the only handoff. The identity map is a pure transform + best-effort Graph/DB
  reads; its **apply decision** lives in Phase 2. ✔ conforms to architecture-boundaries.md.
- **Idempotency:** the only Gemini mutation is the existing idempotent `shareAgent(ALL_USERS)`.
  Handoffs are advisory data regenerated deterministically. Re-running a migration never
  duplicates or over-shares. ✔
- **Multi-tenant:** the new `identityMappings` collection is keyed by `appUserId` (derived from the
  authenticated session, never client-supplied); its query filters by `{ appUserId, tenantId }`.
  New fields on `stagedAgents` inherit that collection's existing `appUserId` scoping. Every new
  query filters by `appUserId`. ✔ conforms to security-rules.
- **Mongo down:** `identityMappings` reads are best-effort (`isDbConnected()` guard → empty map →
  email-match-only fallback, more `unmatched` surfaced honestly). Staging writes of `permissions`/
  `permissionPlan` are best-effort like all staging writes. The migration still runs with Mongo
  down. ✔ conforms to best-effort persistence.

---

## 7. Phased rollout

**P1 — Extract + report only (immediate value, zero destination risk).**
- Ship `AgentIR.permissions`, `readAgentPermissions` in `dataverse.ts`, staging of the block, and
  the report's per-agent "Permissions (source)" section.
- No behavior change in INSERT: sharing stays as-is (`ALL_USERS`). The customer immediately gets a
  truthful picture of source access per agent. Lowest risk, highest early value.

**P2 — Identity map + ALL_USERS-or-handoff.**
- Ship `services/identityMap.ts` + `identityMappings` collection + override-map storage.
- Wire the apply-or-handoff branch in Phase 2: org-wide → `ALL_USERS` (as today, now *justified* by
  source policy); narrower → `PermissionHandoff` + `needs-review` note + the consolidated report
  section. Add the "over-share acceptable" opt-in flag (default off).

**P3 — Automate per-principal apply (future/contingent on Google shipping an API).**
- Designed to slot in without redesign: replace only the "narrower" branch's handoff-generation
  with a real apply call. The `PermissionResolution` (mapped Google users/groups) is already exactly
  the input such an API would need, so P3 is a swap of the terminal step, not a rearchitecture. Add
  the write behind the same `withBackoff`/rate-limiter path as other Gemini writes.
- **P3-alt (optional stopgap, guarded):** a browser-automation of the console Share dialog. Flag the
  risks explicitly — brittle against UI changes, needs an interactive/impersonated admin session
  (conflicts with the app-only/SA model), CAPTCHA/MFA fragility, and it bypasses the API contract.
  Recommend only as an opt-in, clearly-labeled experimental path behind a feature flag, never the
  default. Prefer waiting for the real API.

---

## 8. Out of scope / documented fidelity limits

Stated plainly in the report so the customer is never misled:
- **Granular right-levels are not migrated.** Dataverse Append/AppendTo/Assign/Delete have no Gemini
  equivalent. We map the *coarse* intent (can-chat / can-edit-via-console) and record the rest as a
  `needs-review` note, verbatim. Not lost silently — recorded honestly.
- **Per-agent owner assignment is impossible via API.** Ownership follows the creating identity;
  intended owner is reported as a manual console step.
- **Automated per-user / per-group apply is not buildable today** (API returns 400 for anything but
  `ALL_USERS`; per-agent IAM 404/400). Delivered as a handoff, not a false success.
- **WIF/group federation setup** (mapping Entra groups to Google groups at the IdP level) is a
  customer IdP configuration task; the tool resolves and recommends the target group but does not
  configure federation.

### Drafted Google support / roadmap ask

> **Request:** a REST/gcloud method to set per-principal sharing on a Discovery Engine
> (Agentspace) agent — i.e. `sharingConfig.scope = RESTRICTED` with an explicit
> allow-list of user emails and Google group emails, and/or a per-agent
> `setIamPolicy`. Today `sharingConfig` accepts only `ALL_USERS` via the agent API
> (`RESTRICTED` and per-principal values return HTTP 400), per-agent `getIamPolicy`
> returns 404, and per-agent `setIamPolicy` is a dead-end (400) — the only working
> IAM is engine/project-level, which gates the whole app rather than one agent.
> Per-user/group sharing exists **only** in the console/Agent-Designer UI (owner
> "Share" dialog + admin "User permissions" tab) with no documented API. This blocks
> automated migration of narrower-than-org-wide agent access. A supported API would
> let migration tools honor source access controls instead of either over-sharing
> (`ALL_USERS`) or handing the admin a manual checklist.

---

## Notes (Architect)

**Fidelity impact:** net positive — today source access is silently dropped and everything is
over-shared to `ALL_USERS`. This design makes that honest: org-wide is justified by source policy,
narrower cases become explicit `needs-review` handoffs. No new silent loss; several current silent
losses become surfaced.

**Migration/backward-compat:** `AgentIR.permissions` is additive/optional; already-staged rows and
cached IRs remain valid (`undefined`). New `StagedAgent` fields and the `identityMappings`
collection are additive. Safe to ship P1 with no data migration.

**Risks / open questions:**
- `accesscontrolpolicy` enum values and `AccessMask` encoding vary slightly by Dataverse
  version/org — **Researcher should confirm** the exact numeric enum and mask decoding against a
  live test tenant before P1 extraction ships (the decode table is the one place a wrong assumption
  becomes a fidelity lie).
- Owner **type** discrimination (user vs team) via the `lookuplogicalname` annotation should be
  verified on a real bot row (Copilot auto-creates an owner *team*, so team-owned is the common
  default, not the exception).
- Whether P2's "over-share acceptable" opt-in should exist at all, or whether narrower-than-org-wide
  should *always* stay private-until-manual. Security-leaning default: never auto-`ALL_USERS` a
  restricted agent. Confirm with product.

**Decisions to record (`decisions.md`, drafted):**

> ## 2026-07-29 — Add `AgentIR.permissions`; permissions apply-or-handoff model
> - **Decision:** Extend `AgentIR` with an optional `permissions` block (owner, shared principals
>   + decoded rights, end-user chat access). EXTRACT populates it app-only from Dataverse; INSERT
>   applies `ALL_USERS` only when source chat access is org-wide, otherwise emits a per-agent
>   `PermissionHandoff` + `FidelityNote(needs-review)` and never calls a non-existent per-principal
>   sharing API. Add an `appUserId`-scoped `identityMappings` collection for the Entra→Google
>   override map.
> - **Why:** Gemini's agent API supports only `sharingConfig.scope = ALL_USERS`; per-agent IAM and
>   per-principal sharing do not exist via API (console-only). Silently over-sharing or dropping
>   source access violates fidelity-honesty. Capturing access losslessly + recommending manual
>   steps matches the product's "recommend, don't silently decide" principle.
> - **Impact:** Additive/backward-compatible IR + DB change. P1 = extract+report (zero destination
>   risk); P2 = identity-map + apply/handoff; P3 = swap the handoff for a real API if Google ships
>   one, no redesign. Granular right-levels and per-agent owner assignment are documented out-of-scope.
```
