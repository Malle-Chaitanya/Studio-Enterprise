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

---
---

# Part 2 — Corrected source model, closing the `grantAgentAccess` gap, and Java-derived operational patterns (2026-08-12)

**Status:** Proposed (needs Architect sign-off — expands the `AgentIR`/permission-plan shape again)
**Author:** Architect agent
**Supersedes:** nothing in Part 1 above (Part 1 is shipped and stays correct); this section
extends it with what's changed since — most of it in **shipped code that Part 1's prose never
caught up to** — plus new design for the destination-side gap.

## 0. Premise correction — read this first

The brief that requested this section describes it as extending an **already-written "Part 2"**
of this document (covering `EnvironmentIR`, a `resolvedPrincipalCache`, `PrincipalRef.isExternal`/
`isExternalConfidence`, and `permissionMigrationMode`). **That Part 2 does not exist.** I grepped
this file and all of `server/src` for `EnvironmentIR`, `resolvedPrincipalCache`,
`permissionMigrationMode`, and `isExternal` before writing anything below — zero matches anywhere.
What actually exists is exactly Part 1 above (shipped, per `decisions.md`'s 2026-08-04 entry) plus
real code that has quietly gone **beyond** Part 1's prose without a doc update (see §1). I'm
treating everything below as **newly authored today**, not as a continuation of prior work, and
flagging this discrepancy explicitly rather than pretending to "extend" a document that isn't there
— per this project's own fidelity-honesty discipline, silently reconciling a false premise would be
the wrong move.

A second, smaller premise error in the same brief: the two entity files it names as
`com.cloudfuze.entities.GroupDetails` and `com.cloudfuze.entities.AgentCollabarationDetails` are
not in the `entities` package. The real files are `com.cloudfuze.agent.GroupDetails` and
`com.cloudfuze.agent.AgentCollabarationDetails` (`modules/CloudFuzeCommon/src/main/java/com/
cloudfuze/agent/`). Read and cited correctly below (§4).

## 1. What's actually shipped today vs. what Part 1 documents

Part 1's `SharedPrincipal.roleHint` (§1 above) is `'coauthor' | 'viewer' | 'custom'`. **The real,
shipped `server/src/types.ts` has already gone further**, without a matching doc update:

```ts
export interface SharedPrincipal extends PrincipalRef {
  rights: string[];
  roleHint?: 'coauthor' | 'viewer' | 'custom';
  /**
   * Best-effort Copilot Studio Share-dialog semantics (live-validated 2026-08):
   * - editor — Studio "Editor access" (view/edit/configure/share/publish; not delete)
   * - agent-viewer — Studio "Agent viewer" (Analytics/Evaluation). Often blocked when
   *   the user already has Environment Maker (typical licensed maker).
   * - end-user — Studio "End user access" (chat/connections only; does NOT appear in
   *   the maker Agents list). Usually surfaces via chatAccess, not this record share.
   */
  studioShareRole?: 'editor' | 'agent-viewer' | 'end-user' | 'unknown';
}
```

(`server/src/types.ts:171-188`, decoded in `server/src/services/dataverse.ts`'s
`decodeAccessMask()`, `dataverse.ts:142-184`.) `services/identityMap.ts` and `orchestrator.ts`
already branch on `studioShareRole` (`identityMap.ts:126,246,297,310,317,396`), and
`PermissionHandoff` already carries `chatUsers`/`editorUsers`/`viewerUsers` buckets, not just a
flat `grantUsers`/`grantGroups` pair (`types.ts:246-263`). None of this is in the Part 1 prose
above — it shipped after Part 1 was written and the doc was never updated. **This section is that
update**, plus the actual gap analysis the brief asked for.

## 2. The corrected four-mechanism source model vs. what's extractable today

The three-checkbox "End user access / Agent viewer / Editor access" dialog cited in some earlier
material is **CloudFuze Agent Migration Hub's own UI**, not native Copilot Studio, and must not be
treated as Microsoft's model (confirmed against
`learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots`). The real, native model has
four independently-grantable mechanisms:

| # | Mechanism | Grantable to | Governing Dataverse/Entra surface | Read by `readAgentPermissions` today? |
|---|-----------|--------------|-----------------------------------|----------------------------------------|
| 1 | **Share for chat** | user, security group, "everyone in org" | `ChatBotReaders` privilege (bundled in Environment Maker); env-level, not necessarily a row-share on the bot | **Partially.** The *org-wide/group* form is read via `bot.accesscontrolpolicy` + `authorizedsecuritygroupids` → `ChatAccess`. An **individual** chat share is NOT confirmed to appear anywhere `readAgentPermissions` looks — see §2.1. |
| 2 | **Share for collaborative authoring** | individual only | Row-share via `RetrieveSharedPrincipalsAndAccess` (Write/Append/AppendTo/Share) **+** Environment Maker role (role assignment, not read) | **Row-share rights: yes** (`decodeAccessMask`'s `hasWrite` branch → `studioShareRole: 'editor'`). The Environment-Maker-role co-requirement itself is not read (informational nuance, not needed to detect the grant). |
| 3 | **Share Analytics** | individual only, never groups | Row-share (Read-only) **+** `Analytics Viewer` security role (role assignment) | **Ambiguous — see §2.1.** Bucketed today as `studioShareRole: 'agent-viewer'`, indistinguishable from #4. |
| 4 | **Share Evaluations** | individual only | `Agent Viewer` security role — **may have no row-share on the bot at all** | **Unconfirmed — see §2.1.** Same `'agent-viewer'` bucket as #3, or possibly invisible to extraction entirely. |

### 2.1 The real open question (bigger than "should roleHint have 4 values")

The brief frames deliverable #4 as "does `roleHint` need to expand to stop conflating Analytics
Viewer and Agent Viewer." That framing **understates the risk**. `readAgentPermissions` derives
`studioShareRole` purely from the **row-share `AccessMask`** on the bot record
(`RetrieveSharedPrincipalsAndAccess()`). Mechanisms 3 and 4 are, per Microsoft's docs, granted via
**Dataverse security roles** (`Analytics Viewer`, `Agent Viewer`) — a completely different Dataverse
concept from a record-level share. It is **not yet confirmed**:

- whether granting "Share Analytics" or "Share Evaluations" from the Studio UI *also* creates a
  Read-only row-share on the bot (in which case today's code sees *something*, just mislabels it),
  or
- whether it grants **only** the security-role assignment with **zero** row-share on the bot record
  (in which case today's extraction sees **nothing at all** for these two mechanisms — a silent
  extraction gap, not a labeling gap).

The second case would mean the fidelity issue isn't "Analytics Viewer and Agent Viewer look the
same in the report," it's "Analytics Viewer and Agent Viewer never show up in the report at all,
while other same-shaped Read-only shares silently absorb their bucket." This is exactly the kind of
assumption this codebase's own discipline says must not ship un-verified (see Part 1's existing
open question about `accesscontrolpolicy` encoding, and the `docs/domain/copilot-studio-sharing.md`
reference already cited in `dataverse.ts:177`). **Recommendation: before touching `roleHint`'s
shape, a Researcher/diagnostic-spike pass must confirm on a real tenant** whether "Share Analytics"
/"Share Evaluations" produce a row-share at all, and if so what `AccessMask` they carry, by (a)
granting each from the Studio UI to a throwaway test user, (b) reading `systemuserroles` for that
user to confirm which security role landed, and (c) diffing `RetrieveSharedPrincipalsAndAccess()`
before/after. This is additive to `readAgentPermissions` (a per-shared-principal `systemuserroles`
read) and does **not** cross the phase boundary — still app-only Dataverse reads in EXTRACT.

### 2.2 Recommended target shape (pending §2.1 confirmation)

If §2.1 confirms row-shares exist and are distinguishable (e.g. different `AccessMask` widths, or a
follow-up `systemuserroles` read is needed regardless to disambiguate), expand `studioShareRole` to:

```ts
studioShareRole?: 'editor' | 'chat-share' | 'analytics-viewer' | 'evaluation-viewer' | 'unknown';
```

dropping the merged `'agent-viewer'` token. If §2.1 instead confirms mechanisms 3/4 carry **no**
row-share signal at all, the fix is not a `roleHint` rename — it's a **new read**
(`systemusers({id})/systemuserroles_association?$select=name` for each principal already discovered
via chat/coauthor shares, plus a fresh discovery pass over the environment's role assignments
scoped to this bot — likely infeasible without enumerating all environment users, which is a much
bigger, EnvironmentIR-level concern; see §5). **This is genuinely open — do not implement either
branch without the live confirmation above.**

## 3. Destination side: closing the `grantAgentAccess` gap

### 3.1 Confirmed three-layer model (as given; my own re-verification note below)

1. **License** — `discoveryengine.userStores.{listUserLicenses,batchUpdateUserLicenses}` (Admin-tier
   permissions on a Discovery Engine `userStore`).
2. **Engine/project-level `roles/discoveryengine.agentspaceUser`** — required independently of any
   per-agent grant; without it the agent+session URL itself 403s
   (`WidgetService.LookupWidgetConfig`). Prefer **Engine-level** via `engines.setIamPolicy` (least
   privilege, matches the documented intent of `agentspaceRestrictedUser`'s own description);
   project-level Cloud Resource Manager IAM is the fallback only.
3. **Per-agent `roles/discoveryengine.agentUser`** — already shipped (`gemini.ts:215-262`,
   `grantAgentAccess()`), the only per-agent role that exists; chat-only, no editor/owner tier at
   this grain anywhere.

**Re-verification note:** I attempted to independently re-confirm the exact permission strings via
`WebFetch` against `docs.cloud.google.com/iam/docs/roles-permissions/discoveryengine` (the same
page the brief cites). The page is large enough that my fetch truncated before reaching the
`agentspaceUser`/`userLicenses` sections (it stopped inside the `discoveryengine.admin` role's
permission list). I could not independently re-confirm the literal strings this session; I'm
carrying them forward **as stated in the brief**, which claims live-console + docs verification
already happened, but flagging that my own attempt to double-check them hit a tooling limit rather
than a confirmation. **Before implementing, run a scoped diagnostic spike** (per
`.claude/rules/code-style.md`'s `_diag_*.ts` convention) that calls the literal endpoints below
against a real Gemini Enterprise test project and confirms the response shapes — the same
discipline this codebase already applied to `grantAgentAccess`'s own `getIamPolicy`/`setIamPolicy`
verb discovery (`gemini.ts:228-230`'s comment about an earlier probe wrongly concluding no IAM
existed because it used POST instead of GET).

### 3.2 Confirmed real gap (verified by reading the shipped code, not asserted)

`grantAgentAccess()` (`gemini.ts:215-262`) does exactly layer 3: `GET {agent}:getIamPolicy` →
merge bindings → `POST {agent}:setIamPolicy`. It never checks license state or the engine/project
`agentspaceUser` grant. Its only two callers (`orchestrator.ts:2342`, `orchestrator.ts:2412`) treat
`grant.granted.length > 0` as `status: 'mapped'` — **a false success**: a principal can be in
`grant.granted` (layer 3 succeeded) while still 403ing on open because layers 1–2 were never
checked. I also confirmed there is currently **zero** code anywhere in `server/src` (outside
one-off `spikes/` diagnostics about Reasoning Engine IAM, which is a different resource) that reads
`userLicenses` or calls `engines:setIamPolicy`/`agentspaceUser` — this is not a partial
implementation, it's fully unbuilt. One existing signal already anticipates this: `routes/
identity.ts:107`'s `/principals` response hardcodes `geminiSeat: 'unknown' as const` on every
discovered principal — a placeholder field with nowhere yet to source a real value. That's exactly
where layer-1's result belongs.

### 3.3 Exact call sequence to close the gap

Per-**principal** (not per-agent — cached, see §5.2), run once per migration run:

```
1. CHECK LICENSE
   GET  {userStore}/userLicenses:listUserLicenses?filter=email="{email}"
        permission: discoveryengine.userStores.listUserLicenses
   → licenseState: 'licensed' | 'unlicensed' | 'unknown_error'

2. ASSIGN LICENSE (only if step 1 = 'unlicensed')
   POST {userStore}/userLicenses:batchUpdateUserLicenses
        body: { licenseConfigs: [{ userPrincipal: email, licenseAssignmentState: 'ASSIGNED', ... }] }
        permission: discoveryengine.userStores.batchUpdateUserLicenses
   → on success: licenseState = 'assigned'
   → on capacity/quota error: licenseState = 'capacity_exhausted' (NAMED failure — never silently
     fall through to step 3/4 and report success)
   → on any other error: licenseState = 'unknown_error', carry the raw message

3. CHECK / GRANT ENGINE-LEVEL agentspaceUser (only if steps 1-2 didn't already fail)
   GET  {engine}:getIamPolicy         (reuse the SAME etag read-modify-write pattern
                                        grantAgentAccess already uses for the per-agent case)
   → if member already bound to roles/discoveryengine.agentspaceUser: engineGrantState = 'already_granted'
   → else:
     POST {engine}:setIamPolicy       body: { policy: { bindings: [...existing, +agentspaceUser], etag } }
     → engineGrantState = 'granted' | 'failed'
   FALLBACK (only on explicit customer opt-in — see §3.4): same read-modify-write against
     cloudresourcemanager.projects.{getIamPolicy,setIamPolicy} on the project instead of the engine.

4. PER-AGENT agentUser GRANT (existing, unchanged)
   grantAgentAccess(dest, saToken, agentId, { users, groups })   // gemini.ts:215, as shipped
```

Only step 4 is per-agent; steps 1–3 are per-**principal** and must be cached (a principal shared
across 10 migrated agents should trigger this sequence once, not 10 times — see §5.2).

### 3.4 Engine-level vs project-level: default and opt-in

Per the brief's own instruction to prefer least privilege: **default to Engine-level**
(`engines:setIamPolicy`) for the `agentspaceUser` grant. Project-level Cloud Resource Manager IAM
is materially bigger blast radius — the same category of ask this codebase already treats as
requiring an explicit customer decision, not an automatic default (see `decisions.md`'s 2026-08-03
entry on `ensureReasoningEngineDiscoveryAccess()`: "a materially bigger ask than this product's
normal access model... not recommended as a default"). Wire project-level IAM only behind the same
kind of explicit, cost/scope-disclosed opt-in that entry recommends for the Reasoning Engine case —
never silently escalate scope because the engine-level call failed.

### 3.5 Honest result reporting (the actual fix for "silent failure dressed as success")

```ts
type LicenseState = 'licensed' | 'assigned' | 'capacity_exhausted' | 'unknown_error' | 'not_checked';
type EngineGrantState = 'already_granted' | 'granted' | 'failed' | 'not_checked';

interface PrincipalAccessPrecheck {
  email: string;
  licenseState: LicenseState;
  engineGrantState: EngineGrantState;
  error?: string;
}
```

`orchestrator.ts`'s two `grantAgentAccess` call sites (`~2342`, `~2412`) must be extended: a
principal only earns `FidelityNote(status: 'mapped')` on the sharing note when **all three layers**
succeeded (`licenseState` in `{licensed, assigned}` AND `engineGrantState` in `{already_granted,
granted}` AND the per-agent grant is in `grant.granted`). Any other combination is
`needs-review`, and the note must **name which layer failed** ("license capacity exhausted for
alice@customer.com — chat access will 403 until the admin frees a seat" is a materially different,
more actionable message than today's generic "grant failed"). This is the concrete fix for the gap
named in the brief: today `grant.granted.length > 0` is treated as proof of working access; it
isn't.

## 4. Java-derived operational patterns (file + method cited per pattern)

Read `content-trunk` (staging branch) directly, not from memory of the DB-design doc alone.

| Pattern | Source (file:lines) | How it maps to this design |
|---|---|---|
| **Cache-first principal resolution, reused across a whole run** | `SendingPermissionLoadTask.java:94-119` — `permissionsCounts()` gate before `savePermissionList()`; `findPermissionCache()` populates `mappedPairs` once, reused for every file/folder in the workspace | Direct precedent for the proposed `resolvedPrincipalCache` (§5.2): resolve/license-check/engine-grant a principal **once per run**, not once per agent it appears on. |
| **Per-item unresolved tracking, not just one global list** | `SendingAsyncPermissionsLoadTask.java`'s `filterCollabs()` (~432-580): every source collaborator not found in `mappedPairs` (and not covered by an explicit exception carve-out) is pushed to a **per-file** `notInDestEmails` list, persisted on that file's own `CollabarationDetails` row | Matches this design's `PermissionHandoff.unresolved`, but argues for keeping unresolved tracking **per-agent** (already the shape here) rather than collapsing to one migration-wide list — a customer needs to know *which agent* a principal couldn't be resolved for. |
| **Diff-before-write to avoid duplicate/redundant grants** | `SendingAsyncPermissionsLoadTask.java`'s `commonEmails()`/`fileterInviteEmails()` (~583-731): destination collaborators are fetched first, diffed against the source list, and only the delta is invited | This is exactly the shape `grantAgentAccess()` **already** implements (`getIamPolicy` → diff against existing `members` → only `setIamPolicy` the delta, `gemini.ts:239-248`) — good independent confirmation this is the right pattern, not a gap. Extend the same diff-before-write discipline to the new license/engine-grant checks in §3.3 (don't re-assign a license or re-grant `agentspaceUser` that's already present — the pseudocode in §3.3 already does this). |
| **Bounded fan-out with backpressure, not unbounded parallelism** | `SendingAsyncPermissionsLoadTask.java:379-392` — a `ThreadPoolExecutor`-bounded submission loop that polls `getActiveCount() == getCorePoolSize()` and sleeps 5s before submitting more | Confirms the *direction* (bounded concurrency, never unbounded fan-out at an external API — already this codebase's own rule per `code-style.md`'s `mapPool`). **Do not copy the literal mechanism** — a busy-wait poll-and-sleep loop is real technical debt in the Java code, not a pattern worth reproducing; CS_GE's existing `mapPool` (semaphore/queue-based) is strictly better and should be reused unchanged for the new §3.3 per-principal checks. |
| **Per-branch try/catch, three distinct outcome buckets** | `SendingPermissionLoadTask.java` — repeated `try { fetchFolderCollaborators(...) } catch (CFCloudException e) { exceptionPermission.add(...) }` around every cloud-specific branch (e.g. lines 438-644), with `noPermission`/`exceptionPermission`/`sucessPermission` kept as three separate lists | Precedent for keeping `grant.failed` from becoming one undifferentiated bucket. §3.5's `PrincipalAccessPrecheck` already splits failure by *layer* (license vs engine vs per-agent) — this Java pattern is the reason to keep that split rather than flattening to a single error string, once implemented. |
| **Explicit group-to-group mapping with its own unresolved tracking** | `com.cloudfuze.agent.GroupDetails.java:15-127` (note: **not** `com.cloudfuze.entities.GroupDetails` as the brief stated — corrected path) — `srcGroupId`/`destGroupId` fields plus a group-scoped `notInDestEmails`/`errorCollabarators`, separate from the per-file `CollabarationDetails` tracking | Validates this design's existing `identityMappings.groups: Record<sourceGroupObjectId, googleGroupEmail>` shape (Part 1, §3) and argues for tracking unresolved-group reasons at the **group** grain too, not only flattened into `PermissionResolution.unmatched`. |
| **Rate-limit backoff / retry-on-429** | **Not found.** I grepped `SendingPermissionLoadTask.java`, `SendingAsyncPermissionsLoadTask.java` for `retry|429|backoff|sleep\(`, and grepped `BoxConnector.java` plus the whole `OneDriveConnector`/`SPOMigration` module trees for `429|TooManyRequests|RetryTemplate|exponential|Retry-After` — zero matches anywhere I could reach. | **Flagging honestly rather than inventing a pattern that isn't there.** Either this concern lives in a shared HTTP-client base class I didn't trace into, or this production system genuinely doesn't have explicit backoff at this layer. I am **not** citing a Java precedent for backoff. CS_GE's own `withBackoff`/`services/rateLimiter.ts` (already used by `shareAgent`/`grantAgentAccess`) remains the model — reuse it unchanged for the new license/engine-grant calls in §3.3; nothing in the Java code argues against that. |

## 5. New types (all additive; none of these exist today — see §0)

### 5.1 `EnvironmentIR` (extract + report only, per the brief's stated scope)

Environment-level Dataverse security roles (System Administrator, Environment Maker, Basic User,
System Customizer, Bot Transcript Viewer, custom roles) are org/environment-scoped, not per-agent —
they have **no** Gemini destination equivalent (Gemini has no "environment maker" concept) and are
never an apply target, only a report/audit artifact:

```ts
/** Environment-level Dataverse security-role assignments. Extract + report only —
 *  never an apply target; no Gemini equivalent exists at this scope. */
export interface EnvironmentIR {
  environmentId: string;
  environmentName?: string;
  /** One entry per user/team holding at least one environment-level role relevant
   *  to this migration's agents (owners/coauthors already surfaced elsewhere). */
  roleAssignments: {
    principal: PrincipalRef;
    roles: ('SystemAdministrator' | 'EnvironmentMaker' | 'BasicUser' | 'SystemCustomizer' |
            'BotTranscriptViewer' | 'Custom')[];
    customRoleNames?: string[];
  }[];
  readError?: string;
}
```

Populated by a **new**, best-effort, run-level (not per-agent) read in Phase 1 — a single
`systemuserroles`/`role` query per selected environment, not per bot — staged alongside
`environmentsCache` (the existing per-environment cache collection already in `db/mongo.ts:66-72`).
Rendered in the report as a standalone "Environment access (source, not migrated)" section.
**Never** feeds the apply-or-handoff logic in §3 — it's audit context, e.g. "this agent's owner also
holds System Administrator on the source environment," useful for the customer's own review, never
something this tool acts on.

### 5.2 `resolvedPrincipalCache` (durable, per-`appUserId`+`tenantId`, keyed by principal)

Closes the "check license/engine-grant once per run instead of once per agent" requirement from
§3.3 and §4's Java precedent (cache-first resolution):

```ts
interface ResolvedPrincipalCacheDoc {
  appUserId: string;
  tenantId: string;
  googleEmail: string;           // the resolved destination identity — the cache key's second half
  licenseState: LicenseState;
  engineGrantState: EngineGrantState;
  checkedAt: Date;
  error?: string;
}
```

New collection, indexed `{ appUserId: 1, tenantId: 1, googleEmail: 1 }` unique, added idempotently
in `db/mongo.ts` alongside `identityMappings`. Best-effort like every repo (`isDbConnected()` guard
→ treat as `not_checked` → re-run the live check rather than block). A cache entry older than a
short TTL (propose 24h — license/engine grants don't change mid-run but can change between runs)
should be treated as stale and re-checked, not trusted indefinitely.

### 5.3 `PrincipalRef.isExternal` / `isExternalConfidence`

```ts
export interface PrincipalRef {
  type: 'user' | 'team' | 'group';
  id: string;
  email?: string;
  displayName?: string;
  /** True when the principal's email domain is NOT one of the org's owned domains
   *  (guest/external account). Additive, optional — absent means "not yet classified". */
  isExternal?: boolean;
  /** How confident that classification is — an owned-domain check is a heuristic,
   *  not a directory-verified fact (mirrors identityMap.ts's existing 'email-match'
   *  vs 'email-match-unverified' honesty distinction). */
  isExternalConfidence?: 'confirmed' | 'heuristic';
}
```

Computed in `services/identityMap.ts`'s `resolvePrincipal()` (which already has `ownedDomains` in
scope) — `isExternal = !owned.has(domain)`, `isExternalConfidence = known ? 'confirmed' :
'heuristic'` (reusing the exact same `known`-directory-readable branch that already exists for
`'email-match'` vs `'email-match-unverified'`, `identityMap.ts:78-97`). This is report-only
metadata (flags external collaborators the customer should be aware of before granting Gemini
access) — it does not change the apply-or-handoff branch in §3.

### 5.4 `permissionMigrationMode: 'full' | 'report-only' | 'org-wide-always'`

A per-run, customer-selected mode (lives on the migration run/session, not on `AgentIR` — it's a
policy switch, not extracted data):

- `'full'` (default once P2 ships): the §3 apply-or-handoff logic as designed — org-wide chat →
  `ALL_USERS`; narrower → resolve + attempt the §3.3 sequence + handoff for anything unresolved.
- `'report-only'`: run identity resolution and produce the full report/handoff, but make **zero**
  Gemini sharing/license/IAM calls — useful for a customer who wants the audit trail before
  granting CloudFuze's SA the `agentspaceUser`/license-admin scopes §3 needs. This is the safe
  default for a first-run trust-building pass.
- `'org-wide-always'`: today's existing (pre-this-design) behavior, kept as an explicit, named
  opt-out for a customer who has already decided org-wide sharing is acceptable for all agents —
  **never** the default; must be an explicit choice, consistent with security-rules' "never
  over-share by default."

Threaded through the same place `GeminiDestination.edition` already lives (`types.ts:447-462`) —
an explicit, un-auto-detected field the caller sets, not inferred.

## 6. Full corrected mapping table (four source mechanisms × three destination layers)

| Source mechanism | Maps to destination... | Fidelity |
|---|---|---|
| Share for chat (org-wide / `accesscontrolpolicy` = any\|any-multitenant) | Layer-2+3 combined: `shareAgent(ALL_USERS)` (existing, unchanged) | **Mapped** — clean equivalence. |
| Share for chat (group-restricted / individual) | Layers 1+2+3 via §3.3's new sequence, per resolved principal | **Mapped when all 3 layers succeed; needs-review naming the failed layer otherwise** (§3.5) — this is the corrected, honest version of today's over-claimed "mapped." |
| Share for collaborative authoring (coauthor/editor) | **No destination equivalent.** Gemini has no per-agent co-admin/editor tier at any IAM layer (confirmed: even `agentspaceEditor` at the project/engine level caps at chat-only per-agent). | **Lost — always `needs-review`.** Must never be "solved" by granting a broader Gemini role to compensate (explicit rule already encoded in `identityMap.ts:243`'s handoff text: "NEVER auto-grant roles/discoveryengine.editor... least-privilege"). |
| Share Analytics | **No destination equivalent** (Gemini has no per-agent analytics-sharing surface). | **Lost — needs-review.** Whether extraction even sees this grant today is the open §2.1 question. |
| Share Evaluations | **No destination equivalent.** | **Lost — needs-review.** Same §2.1 caveat. |
| Owner | No settable-owner API; creator identity (SA/DWD) owns. | **needs-review**, unchanged from Part 1. |
| Environment-level Dataverse roles (System Admin, Environment Maker, Basic User, System Customizer, Bot Transcript Viewer, custom) | **No destination equivalent at any layer** — Gemini has no environment/maker-role concept. | **Extract + report only** (`EnvironmentIR`, §5.1) — never an apply target, never attempted. |

## Implementation Sequence (hand-off-ready)

1. **Researcher/diagnostic-spike task (blocking, do first):** confirm §2.1 — does Studio's "Share
   Analytics"/"Share Evaluations" produce a row-share on the bot at all, and if so what `AccessMask`.
   Without this, any `studioShareRole` expansion is guessing.
2. **Diagnostic-spike task (blocking for §3, can run in parallel with #1):** confirm the literal
   REST paths for `userLicenses:listUserLicenses`/`:batchUpdateUserLicenses` and
   `engines:setIamPolicy` for `agentspaceUser` against a real test project — my own doc re-fetch
   truncated before confirming these (§3.1).
3. Add `EnvironmentIR` (§5.1) to `types.ts`; wire a new, run-level (not per-bot) best-effort read
   into Phase 1 near the existing `environmentsCache` build; render as a new, clearly-separate
   "Environment access (source, not migrated)" report section. No apply-side change.
4. Add `PrincipalRef.isExternal`/`isExternalConfidence` (§5.3) to `types.ts`; compute in
   `identityMap.ts`'s `resolvePrincipal()`; surface in the report next to each principal — no
   apply-side change.
5. Add `resolvedPrincipalCache` (§5.2): new repo module `db/repos/resolvedPrincipalCache.ts`,
   collection + unique index added idempotently in `db/mongo.ts`.
6. Implement the §3.3 sequence as new `services/gemini.ts` functions (`checkUserLicense`,
   `assignUserLicense`, `ensureEngineAgentspaceUser`), gated by the outcome of steps 1–2 above —
   do not hardcode paths guessed in this doc without that confirmation.
7. Wire `PrincipalAccessPrecheck` (§3.5) into `orchestrator.ts`'s two `grantAgentAccess` call sites
   (`~2342`, `~2412`); change the `mapped`/`needs-review` decision to require all three layers.
8. Add `permissionMigrationMode` (§5.4) to the destination/session config; default to
   `'report-only'` for first-run customers per this document's security-leaning stance (mirrors
   Part 1's own unresolved question about whether "over-share acceptable" should even be an
   opt-in — resolve both in the same product conversation).
9. Only once §2.1 is confirmed: implement the corresponding `studioShareRole` expansion (§2.2) and
   update `identityMap.ts`'s branching + `PermissionHandoff`'s bucket fields accordingly.
10. Update this document's Part 1 prose to match what §1 found already shipped (the `studioShareRole`
    field, the `chatUsers`/`editorUsers`/`viewerUsers` handoff buckets) — small doc-hygiene pass so
    the next reader doesn't hit the same premise-mismatch this section opened with.

## Notes

**Fidelity impact:** Net positive, same direction as Part 1 — this section turns an over-claimed
"mapped" (grant succeeded at layer 3 while layers 1-2 were never checked) into an honest,
layer-specific `needs-review`, and gives Analytics/Evaluation viewer shares a named "no destination
equivalent" outcome instead of a merged, ambiguous bucket. `EnvironmentIR` adds visibility with zero
apply-side risk (it's never an apply target).

**Migration/backward-compat:** every new type here is additive/optional on `AgentIR` or lives on
new collections; nothing existing changes shape. `permissionMigrationMode` defaulting to
`'report-only'` is a **behavior-narrowing** default for new runs relative to today's implicit
`'full'`-equivalent behavior — call this out explicitly to product/CEO review before shipping,
since it changes what a customer gets without configuration, even though it's the more honest and
less risky default.

**Risks / open questions (in addition to §2.1 and §3.1's confirmed-blocking items):**
- Whether `resolvedPrincipalCache`'s 24h TTL is right — an admin could revoke a license mid-run;
  the cache would report stale `'licensed'` until the next check. Propose product confirms the
  acceptable staleness window.
- `EnvironmentIR`'s "one query per environment, not per bot" design assumes a full
  `systemuserroles` scan is feasible at the environment scope the app-only token already has
  access to for other reads (`environmentsCache`) — not yet confirmed against a large real tenant;
  flag as a scale risk if an environment has thousands of role assignments.
- The premise correction in §0 means this section's "Part 2" framing is really "Part 2, written for
  the first time today" — if the brief's original Part 2 was written by a *different* session and
  simply never got saved/committed, that lost work should be recovered/reconciled rather than this
  section being treated as the sole source of truth going forward. Flagging so nobody assumes this
  is a straightforward continuation.

**Decisions to record (`decisions.md`) — see the two new entries added for 2026-08-12.**
