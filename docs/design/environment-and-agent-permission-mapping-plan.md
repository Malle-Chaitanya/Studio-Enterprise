# Plan: Environment & Agent Permission/User Mapping (Copilot Studio → Gemini Enterprise)

**Status:** Build plan — ready to implement. Consolidates and supersedes the exploratory content in
[permission-mapping.md](permission-mapping.md) into one buildable reference. See that doc for the
full investigation history, live-testing evidence, and citations behind each decision below.

**Scope for this pass:** three environment roles (System Administrator, Environment Maker, Basic
User) and full agent-level permission mapping. Analytics Viewer / Agent Viewer (evaluation) roles are
explicitly deferred — see Open Questions.

---

## 1. The two problems this plan solves

1. **Identity resolution** — who is this Microsoft principal on the Google side? A pure data
   problem, fully solvable.
2. **Permission application** — can Gemini actually be made to enforce the same access? Bounded by
   what Google's API can do. Now fully mapped for the in-scope roles.

---

## 2. Data model additions

```typescript
/** One per environment, NOT per agent. Extract+report only — see §5. */
interface EnvironmentIR {
  environmentId: string;
  roleAssignments: EnvironmentRoleAssignment[];
  readError?: string;                 // best-effort; never blocks extraction
}

interface EnvironmentRoleAssignment {
  principal: PrincipalRef;
  role: 'SystemAdministrator' | 'EnvironmentMaker' | 'BasicUser';
}

/** Existing AgentIR.permissions — unchanged, already shipped. */
interface AgentPermissions {
  owner?: PrincipalRef;
  sharedPrincipals: SharedPrincipal[];  // coauthor / viewer / custom
  chatAccess?: ChatAccess;              // any / group / copilot-readers / unknown
  readError?: string;
}

/** New — resolved identity, cached durably across the whole engagement,
 *  shared by BOTH the environment-role flow and the agent-permission flow
 *  so a person is only ever resolved once, not once per role/agent. */
interface ResolvedPrincipalCache {
  sourcePrincipal: string;              // email/UPN or Entra group objectId
  googlePrincipal?: { type: 'user' | 'group'; email: string };
  via: 'override' | 'email-match' | 'unmatched';
  hasLicense?: boolean;
  hasEngineRole?: boolean;
  lastCheckedAt: Date;
}
```

New collections: `environmentAccessSnapshots`, `resolvedPrincipalCache`. Both additive, both
`appUserId`-scoped, both best-effort per this project's persistence rules.

---

## 3. Confirmed destination model (Gemini Enterprise)

Three independent layers, each isolated by live testing against a real agent and cross-checked
against Google's own IAM roles/permissions reference:

```
  1. LICENSE              2. SCOPE-LEVEL ROLE            3. PER-AGENT ROLE
 ┌───────────────┐      ┌────────────────────────┐     ┌──────────────────┐
 │ Gemini Enter- │  →   │ roles/discoveryengine  │  →  │ roles/discovery- │
 │ prise license │      │ .agentspaceUser         │     │ engine.agentUser │
 │ assigned      │      │ (engine-level preferred)│     │ (chat-only —     │
 │               │      │                         │     │  no editor tier  │
 │               │      │                         │     │  exists here)    │
 └───────────────┘      └────────────────────────┘     └──────────────────┘
  listUserLicenses /     engines.setIamPolicy /          getIamPolicy(GET) +
  batchUpdateUser-       cloudresourcemanager            setIamPolicy(POST),
  Licenses               .setIamPolicy                   etag round-trip —
                                                          ALREADY BUILT
                                                          (grantAgentAccess,
                                                          services/gemini.ts)
```

Missing layer 1 or 2 → every page 403s (`WidgetService.LookupWidgetConfig`), including the direct
agent URL — not just the app home page. No editor/co-author tier exists at the agent grain at all;
ownership always follows the creating identity.

---

## 4. Environment-role mapping (System Administrator / Environment Maker / Basic User)

**The container mapping (Environment → Project + Engine) is already built** — every environment
resolves at runtime to a GCP project + Gemini Enterprise engine (`services/destination.ts`,
`routes/destination.ts`). Nothing new needed there.

**The role mapping:**

| Environment role (source) | Gemini role (destination) | Grant scope | Applied how |
|---|---|---|---|
| System Administrator | `roles/discoveryengine.agentspaceAdmin` | Project-level | One person at a time, explicit confirm — **never automatic, never bulk** |
| Environment Maker | `roles/discoveryengine.agentspaceEditor` | Project-level | Bulk-reviewable recommendation, customer opts in |
| Basic User | `roles/discoveryengine.agentspaceUser` | Engine-level (preferred) | **Not separate work** — identical to layer 2 of §5's chain; covered automatically once that's built |

Flow:

```
EXTRACT   Dataverse systemuserroles/team-role read (opt-in — bigger privilege ask
          than anything else this tool reads today)
          → EnvironmentIR

RESOLVE   Same identityMap.ts 3-tier logic (override → email-match → unmatched),
          result cached in ResolvedPrincipalCache

RECOMMEND Surfaced in the report + a new panel off SelectMap — the proposed
          role mapping per person, unmatched principals flagged for decision

APPLY     Admin  → one-at-a-time confirmed grant only
          Maker  → bulk-reviewable confirmed grant
          User   → automatic, via the shared engine-role check in §5
```

Admin and Maker are genuinely new work and genuinely higher-stakes than anything else in this
plan — a wrong grant here affects the whole project, not one agent. That is why they are
recommend-and-confirm, never silent.

---

## 5. Agent-level permission mapping

```
EXTRACT (shipped — services/dataverse.ts: readAgentPermissions)
  → AgentIR.permissions { owner, sharedPrincipals[], chatAccess }

RESOLVE (shipped — services/identityMap.ts)
  → same 3-tier logic, same ResolvedPrincipalCache reuse as §4

APPLY (orchestrator.ts Phase 2 — extends services/gemini.ts)

  if chatAccess.policy in {'any', 'any-multitenant'}:
      shareAgent(dest, saToken, agentId, ALL_USERS)             ← shipped

  else:  // restricted — THE SEQUENCE TO BUILD
      for each resolved principal in sharedPrincipals + chatAccess groups:

        1. checkLicense(principal)
             discoveryengine.userStores.listUserLicenses
           → missing? assignLicense() via .batchUpdateUserLicenses if
             capacity allows, else named failure "no license available"
             → PermissionHandoff for this principal

        2. checkEngineRole(principal)
             engines.getIamPolicy on the destination engine
           → missing agentspaceUser? engines.setIamPolicy to add it
             (read-modify-write with etag)

        3. grantAgentAccess(dest, saToken, agentId, principal)   ← shipped
             GET {agent}:getIamPolicy → append roles/discoveryengine.agentUser
             → POST {agent}:setIamPolicy (etag round-trip)

      any step fails for a principal → PermissionHandoff entry
        (shipped — resolved Google identity + exact console steps)

REPORT (extends report.ts)
  Per agent: auto-applied / manual handoff (named reason) / out of scope
  (co-author/editor access — no destination equivalent exists)
```

**The one confirmed real bug this plan fixes:** `orchestrator.ts` currently treats
`grantAgentAccess()` succeeding as proof the person can use the agent. It never checks steps 1–2.
Today, sharing a restricted agent with someone missing a license or the engine role reports success
while they sit behind a 403 wall — a silent failure dressed as success. `routes/identity.ts` already
has a placeholder (`geminiSeat: 'unknown' as const`) anticipating exactly this fix.

---

## 6. Build order

1. **Spike (blocking §7 only, not this plan's in-scope roles):** confirm whether Analytics Viewer /
   Agent Viewer sharing produces a readable row-share in Dataverse at all.
2. **Spike:** live-reconfirm the exact REST paths for `listUserLicenses` / `batchUpdateUserLicenses`
   / `engines.setIamPolicy` against Google's current docs — do not trust a search-tool summary.
3. Add `EnvironmentIR` + the opt-in Dataverse read.
4. Add `ResolvedPrincipalCache` collection + repo, shared by both flows.
5. Implement `checkLicense` / `assignLicense` / `checkEngineRole` in `services/gemini.ts`.
6. Wire the full 3-step sequence into both `orchestrator.ts` `grantAgentAccess` call sites — success
   now requires all three steps.
7. Build the environment-role recommend/confirm UI surface (report section + SelectMap panel).
8. Extend `report.ts` with the three-bucket breakdown (auto-applied / manual / out of scope).

---

## 7. Open questions, explicitly deferred (not blocking this pass)

- Whether Analytics Viewer / Agent Viewer sharing is even visible to extraction at all (row-share vs.
  security-role mechanism) — deferred since those two roles are out of scope for this pass.
- Whether `agentspaceAdmin` / `agentspaceEditor` can be scoped to one engine (only `agentspaceUser`
  has been live-confirmed at engine grain) — worth checking before finalizing that column.
- Default value for a future `permissionMigrationMode` toggle — needs product sign-off, not just
  engineering, since a `'report-only'` default would narrow current behavior.

---

## 8. Out of scope, stated plainly

- Co-author/editor access on one agent — no such role exists at any grain on Gemini; ownership
  always follows the creating identity.
- Analytics Viewer / Agent Viewer roles — deferred, see §7.
