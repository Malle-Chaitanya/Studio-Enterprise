# Design: Multiple connected Gemini Enterprise target accounts per session

Status: Draft for Architect / product sign-off
Author: Architect agent
Pipeline stage(s) touched: **connect / plan (pre-extract)** and **INSERT** (target identity).
No change to EXTRACT, mapping, `AgentIR`, or the fidelity report content.

---

## Summary

Today a migration session holds exactly **one** connected Gemini Enterprise (Google)
target — a flat set of fields on the session (`gEmail`, `gToken`, `geminiProject`, `saOk`,
`saReason`). Connecting a second Google account **overwrites** the first (the OAuth callback
at [server/src/routes/auth.ts:283](../../server/src/routes/auth.ts) does a single
`updateSession(...)` on those fields), which is why "+ Add Another" on the Gemini card only
ever shows the one account.

This design changes the **target side** of a session from single-slot to a **list of connected
Google accounts** plus a pointer to which one is currently selected, and makes each migration
**run** snapshot the exact account it targeted so runs stay deterministic and resumable. The
source (Microsoft) side is deliberately left single-slot — it defines the whole tenant context
of a session and is out of scope here.

This is Phase-1, agents-only work. It does **not** touch the two-phase EXTRACT/INSERT boundary,
the `AgentIR` contract, or the DB schema of any migration-scoped collection. The only stored
shape that changes is the `migrationSessions` session document, handled with a
backward-compatible read-time normalizer.

---

## Background: what "the target" actually is (read this first)

A "connected Gemini account" is really four pieces of state, and it helps to separate them
because they are used in different places:

| Field | What it is | Where it's used today |
|-------|------------|-----------------------|
| `gEmail` | The Google admin who signed in (identity label + **DWD impersonation subject**) | [destination.ts](../../server/src/routes/destination.ts) `getSaToken(session.gEmail)`, [orchestrator.ts:210-220](../../server/src/orchestrator.ts), [organizationProfile.ts:49-59](../../server/src/services/organizationProfile.ts) |
| `gToken` | That admin's **OAuth access token** — only used to *discover* their Cloud projects/engines | [destination.ts:24](../../server/src/routes/destination.ts) `listProjects(session.gToken)` |
| `geminiProject` | The discovered default Gemini project (fallback destination) | [orchestrator.ts:159,170](../../server/src/orchestrator.ts) `defaultDestination(project)`, destination routes |
| `saOk` / `saReason` | Whether **CloudFuze's service account** can reach that project (Direct IAM or DWD), and why not | shown in UI, gates readiness |

Crucial nuance for reviewers: **privileged Gemini writes never use `gToken`.** They use
CloudFuze's service account (`getSaToken()` direct, or `getSaToken(gEmail)` for Domain-Wide
Delegation). So `gToken` is a short-lived discovery token; the account's durable target identity
is `gEmail` + `geminiProject` + the SA-reachability verdict. This matters because we do **not**
need to keep OAuth tokens fresh for every held account — only for the one currently being used to
browse projects/engines.

Also note the destination **routing** is already partly decoupled: the per-environment
`environmentMap` (env url -> `{project, engine, assistant}`) chosen on the SelectMap screen
([web/src/pages/SelectMap.tsx](../../web/src/pages/SelectMap.tsx)) is carried in
`ResolvedPlan.destination` ([types.ts:210-243](../../server/src/types.ts)). What is *not*
decoupled is the **auth identity** and the **default fallback project**, both read straight off
the single session slot in [orchestrator.ts:159-160](../../server/src/orchestrator.ts). That
single-identity assumption is the real thing this design has to fix.

---

## Architecture

### Components involved and data flow

```
                        (unchanged: source / EXTRACT side)
  Copilot/Dataverse ──► stagedAgents ──► INSERT ──► Gemini
                                            ▲
                                            │ target identity (gEmail, project, SA verdict)
   ┌────────────────────────────────────────────────────────────────┐
   │ CONNECT (Home.tsx)                                               │
   │  google OAuth callback ──► APPEND/DEDUPE into session.googleAccounts[]
   │  "select target"       ──► session.activeGoogleId                │
   │  "disconnect one"      ──► remove from session.googleAccounts[]  │
   └────────────────────────────────────────────────────────────────┘
                    │ activeGoogleId drives discovery
                    ▼
   SelectMap discovery (projects/engines) uses the ACTIVE account's gToken/gEmail
                    │
                    ▼
   POST /migrate/plan  ──► snapshots the chosen account into ResolvedPlan.targetAccount
                    │
                    ▼
   orchestrator reads plan.targetAccount (NOT the live session pointer)
```

### Where it sits across the phase boundary

Entirely on the **connect + plan** side and the **target-identity input** to INSERT. The
staging DB handoff is untouched: EXTRACT still writes `stagedAgents`, INSERT still reads them.
Extraction code still never learns which Google account exists. This respects
[.claude/rules/architecture-boundaries.md](../../.claude/rules/architecture-boundaries.md):
the change stays in routes -> orchestrator -> services and never crosses EXTRACT into INSERT.

### AgentIR impact: **NO.**

`AgentIR`, `TopicIR`, `KnowledgeSourceIR` are unchanged. This feature is about *where* a mapped
agent lands, not *what* is extracted or mapped. No `decisions.md` entry is needed for an IR
change because there is none.

### DB-schema impact: **YES, but only the session document** (and backward-compatible).

- `migrationSessions` documents gain `googleAccounts: GoogleAccount[]` and `activeGoogleId?`.
  The flat `gEmail`/`gToken`/`geminiProject`/`saOk`/`saReason` fields are **retained** (kept in
  sync with the active account) for one release so an older server instance and any un-migrated
  reader keep working. No index change; the TTL index on `createdAtDate` is unaffected.
- No change to `migrationRuns`, `migrationResults`, `agentIRCache`, `environmentsCache`,
  `migrationLogs`, `stagedAgents`. **This is not a new collection and not a schema migration
  script** — it is a lazy, read-time normalization (see Backward-compat below).

This session-shape change is an architectural decision worth a one-line note in
[.claude/memory/decisions.md](../../.claude/memory/decisions.md) even though it isn't an IR
change, because it alters the persisted session contract.

---

## 1. New session data model

Add a `GoogleAccount` type and change the Google side of `Session` from flat fields to a list +
active pointer. Proposed shape (in [server/src/sessionStore.ts](../../server/src/sessionStore.ts),
or move the type to [server/src/types.ts](../../server/src/types.ts) next to the other shared
shapes — recommended, since routes and the orchestrator both consume it):

```ts
/** One connected Gemini Enterprise (Google) target account held on a session. */
export interface GoogleAccount {
  /** Stable server-generated id for this account within the session (newId()). */
  id: string;
  /** Google admin who signed in — identity label AND DWD impersonation subject. */
  gEmail: string;
  /** OAuth access token, used ONLY to discover this admin's projects/engines.
   *  Short-lived; may be absent/expired for a held-but-not-active account. */
  gToken?: string;
  /** Discovered default Gemini project for this account. */
  geminiProject?: string;
  /** Can CloudFuze's SA reach this project (Direct IAM or DWD)? */
  saOk?: boolean;
  /** Why saOk is false — shown to the client. */
  saReason?: string;
  /** When this account was connected/last refreshed (for display + freshness). */
  connectedAt: number;
}

export interface Session {
  step: string;
  createdAt: number;
  appUserId?: string;
  // ── Microsoft side (UNCHANGED — single-slot by design) ──
  tenantId?: string;
  orgName?: string;
  msEmail?: string;
  refreshToken?: string;
  dvToken?: string;
  dvDelegatedToken?: string;
  dvOrgUrl?: string;
  environments?: { name: string; url: string; id: string }[];
  botCount?: number; topicCount?: number; flowCount?: number; ksCount?: number;

  // ── Google side (NEW: list + active pointer) ──
  /** All connected Gemini targets on this session. */
  googleAccounts?: GoogleAccount[];
  /** Which GoogleAccount.id is currently selected as the default target. */
  activeGoogleId?: string;

  // ── DEPRECATED single-slot mirror of the ACTIVE account (kept 1 release) ──
  /** @deprecated read via googleAccounts + activeGoogleId; mirror of active account. */
  gEmail?: string;
  /** @deprecated */ gToken?: string;
  /** @deprecated */ geminiProject?: string;
  /** @deprecated */ saOk?: boolean;
  /** @deprecated */ saReason?: string;

  plan?: ResolvedPlan;
  msSessionId?: string;
}
```

Add small helpers to `sessionStore.ts` so no consumer reaches into the raw arrays:

```ts
/** The currently-selected target account (active pointer, else first, else undefined). */
export function activeGoogleAccount(s: Session): GoogleAccount | undefined;
/** Look up a specific held account by id. */
export function googleAccountById(s: Session, id: string): GoogleAccount | undefined;
```

### Backward-compat with already-persisted single-slot sessions

The `migrationSessions` collection has a 1-hour TTL, so most live sessions age out quickly — but
we must not break a session mid-flow after a deploy. Strategy: **normalize on read, mirror on
write. No migration script.**

1. **Read-time normalizer** in `toSession()` (the single funnel every read passes through,
   [sessionStore.ts:69-75](../../server/src/sessionStore.ts)): if a loaded doc has no
   `googleAccounts` but has a flat `gEmail`, synthesize
   `googleAccounts = [{ id: newId(), gEmail, gToken, geminiProject, saOk, saReason, connectedAt: createdAt }]`
   and set `activeGoogleId` to that id. Now every consumer sees the list shape regardless of what
   is on disk. This also covers the in-memory fallback path (Mongo down).
2. **Write-time mirror**: whenever we mutate `googleAccounts`/`activeGoogleId`, also `$set` the
   five deprecated flat fields from the active account (a tiny `syncActiveMirror(session)`
   helper). This keeps old readers (and an old server binary during a rolling deploy) correct,
   and gives us a clean rollback: revert the code and the flat fields are still populated.
3. After one release, delete the deprecated fields and the mirror write. That removal is its own
   small PR.

Because normalization is lazy and idempotent, an un-migrated doc simply becomes normalized the
next time it is written — no batch job, and the app still boots with Mongo down.

---

## 2. Where the migration target gets chosen (the deep question)

**Recommendation: the session holds the list + `activeGoogleId` for UI/discovery convenience, but
the migration RUN is bound to a target that is SNAPSHOTTED into the plan at plan time. The
orchestrator reads the target from the plan, never from the live session pointer.**

Why snapshot into the plan rather than read `activeGoogleId` at run time:

- **Determinism / no race.** A user can hold several accounts and could re-select the active one
  (or open a second browser tab) between planning and streaming. If the orchestrator read the
  live pointer, the run could silently retarget. Snapshotting makes "what you planned is what you
  get."
- **Two-phase honesty / resumability.** The plan already lives on the session and is the thing a
  retryable INSERT run consumes. Binding the target to the plan means a re-run targets the same
  account without re-selecting — consistent with the "staging decouples the phases" principle.
- **Fidelity honesty.** The report is per-run; the run's target is unambiguous and can be printed
  in the report header.

Concretely, add the chosen account to the resolved plan (in [types.ts](../../server/src/types.ts)):

```ts
/** Snapshot of the Gemini target account this plan/run is bound to. */
export interface PlanTargetAccount {
  accountId: string;      // GoogleAccount.id at plan time
  gEmail: string;         // impersonation subject for SA/DWD
  geminiProject: string;  // default fallback project
}

export interface ResolvedPlan {
  units: ScopeUnit[];
  totalAgents: number;
  destination: DestinationOptions;
  targetAccount?: PlanTargetAccount;   // NEW — bound at plan time
  dryRun?: boolean;
}
```

Impact trace:

- **`POST /api/migrate/plan`** ([migrate.ts:14-44](../../server/src/routes/migrate.ts)): accept an
  optional `targetAccountId` in the body. Resolve it (default to `activeGoogleAccount(session)`),
  and set `plan.targetAccount = { accountId, gEmail, geminiProject }`. If the session has Google
  accounts but the requested/active one can't be resolved, return `400 { error: 'target_account_required' }`.
  Dry-run plans may leave `targetAccount` undefined (no target needed — matches today's behavior).
- **`resolveScope`** ([scope.ts:30-76](../../server/src/services/scope.ts)): unchanged. It only
  expands source scope + passes `destination` through; it doesn't need the target account.
- **Orchestrator `execute()`** ([orchestrator.ts:158-237](../../server/src/orchestrator.ts)):
  replace the two reads
  ```ts
  const project = session.geminiProject ?? '';
  const gEmail  = session.gEmail ?? '';
  ```
  with a resolve-from-plan-first, fall-back-to-active-account helper:
  ```ts
  const target = plan.targetAccount
    ?? toPlanTarget(activeGoogleAccount(session)); // back-compat for old plans/dry runs
  const project = target?.geminiProject ?? '';
  const gEmail  = target?.gEmail ?? '';
  ```
  Everything after that (the SA-auth block at 200-237, `defaultDestination(project)`,
  `resolveDestination(project, saToken)`, `getSaToken(gEmail)`) is unchanged — it just consumes
  `project`/`gEmail` from the resolved target. The per-environment `environmentMap` continues to
  win over the default where the user mapped an environment.

This is the smallest change that removes the single-identity assumption while respecting the
layering: routes resolve the choice, the plan carries it, the orchestrator consumes it.

---

## 3. OAuth flow changes

The whole change is in the **Google callback** ([auth.ts:261-293](../../server/src/routes/auth.ts));
the OAuth `state` handling and the DWD/bypass paths stay as they are.

- **Append + dedupe instead of overwrite.** Today the callback does
  `updateSession(msSessionId, { ...gEmail, gToken, geminiProject, saOk, saReason })`, clobbering
  the slot. New logic:
  1. Compute `gEmail`, `gToken`, `geminiProject`, `saOk`, `saReason` exactly as now.
  2. Load the session, take `googleAccounts` (via the normalizer, so a legacy session already has
     its one account).
  3. **Dedupe by lowercased `gEmail`**: if an account with the same email exists, update that
     entry in place (refresh `gToken`, `geminiProject`, `saOk`, `saReason`, `connectedAt`) rather
     than adding a duplicate. Otherwise push a new `GoogleAccount` with `id = newId()`.
  4. Set `activeGoogleId` to the just-connected account (connecting an account selects it — matches
     user expectation).
  5. Persist the list + active pointer, and `syncActiveMirror` the deprecated flat fields.
- **`state` handling — unchanged.** The signed state already carries `msSessionId` + `popup`
  ([auth.ts:104-127](../../server/src/routes/auth.ts)); the Google connect flow links back to the
  existing session, which is exactly what append needs. No CSRF/nonce change.
- **Dev bypass path** ([auth.ts:244-256](../../server/src/routes/auth.ts)): apply the same
  append/dedupe so bypass mode also produces a list (single entry) rather than the flat slot.
- **Popup postMessage contract** (`google-auth-success` / `google-auth-error`) is unchanged — the
  web client just refetches the session summary and sees the new list.

Note on tokens: only the **active** account's `gToken` needs to be usable for project/engine
discovery. Held-but-inactive accounts may have a stale `gToken`; that is fine because writes use
the SA, not `gToken`. If a user re-selects an account whose discovery token has expired and tries
to browse projects, the destination route returns an empty project list (its existing behavior),
and the UI prompts a reconnect (which re-runs OAuth and refreshes that entry via dedupe).

---

## 4. API changes

All new/changed responses keep the project conventions from
[.claude/rules/api-conventions.md](../../.claude/rules/api-conventions.md): plain data objects,
`snake_case` error codes, session id as query param (GET) / body field (POST), and **no change to
the `ProgressEvent` union** (this feature adds no new SSE event kinds).

### 4a. Session summary — `GET /api/auth/session/:id` ([auth.ts:296-315](../../server/src/routes/auth.ts))

Add a `googleAccounts` array and `activeGoogleId`. Keep the existing top-level
`gEmail`/`geminiProject`/`saOk`/`saReason` mirroring the **active** account so an old web build
keeps working during rollout:

```jsonc
{
  "step": "ready",
  "orgName": "...", "msEmail": "...", "tenantId": "...", "environments": 3,
  "botCount": 12, "topicCount": 40, "ksCount": 5, "flowCount": 2,

  "googleAccounts": [
    { "id": "a1", "gEmail": "zara@storefuze.com", "geminiProject": "proj-123",
      "saOk": true,  "saReason": null, "connectedAt": 1753600000000 },
    { "id": "b2", "gEmail": "admin@acme.com",      "geminiProject": "proj-987",
      "saOk": false, "saReason": "Grant our SA the Discovery Engine Admin role", "connectedAt": 1753600500000 }
  ],
  "activeGoogleId": "b2",

  // deprecated mirror of the active account (removed next release):
  "gEmail": "admin@acme.com", "geminiProject": "proj-987", "saOk": false, "saReason": "...",

  "connected": { "microsoft": true, "google": true }  // google = googleAccounts.length > 0
}
```

Never return `gToken` (unchanged — the summary is secrets-free).

### 4b. Select active target — `POST /api/auth/target/select` (NEW)

```
body:  { session: string, accountId: string }
200:   { ok: true, activeGoogleId: string }
404:   { error: 'session_not_found' }
404:   { error: 'account_not_found' }
```

Sets `session.activeGoogleId = accountId` (after verifying the account exists) and re-syncs the
deprecated mirror. Pure connect-side; no orchestrator involvement.

### 4c. Disconnect one of many — `POST /api/auth/disconnect` ([auth.ts:323-338](../../server/src/routes/auth.ts))

Extend the existing endpoint (don't add a new one):

```
body:  { session, platform: 'google', accountId?: string }
```

- `platform: 'google'` **with** `accountId`: remove that one account from `googleAccounts`. If it
  was active, set `activeGoogleId` to the first remaining account (or clear it if none remain).
  `step` returns to `'ms_done'` only when the list becomes empty. Response:
  `{ ok: true, platform: 'google', accountId, remaining: <count>, activeGoogleId }`.
- `platform: 'google'` **without** `accountId`: legacy behavior — clear ALL Google accounts
  (equivalent to the old single-slot disconnect). Keeps old clients working.
- `platform: 'microsoft'`: unchanged — deletes the whole session
  ([auth.ts:333-336](../../server/src/routes/auth.ts)).
- New error where relevant: `404 { error: 'account_not_found' }`.

### 4d. Destination discovery — `GET /api/destination/{projects,engines,validate}` ([destination.ts](../../server/src/routes/destination.ts))

These read `session.gToken` / `session.gEmail` / `session.geminiProject`. Change them to resolve
the account first: accept an optional `&account=<id>` query param, default to
`activeGoogleAccount(session)`, and read `gToken`/`gEmail`/`geminiProject` off that account. Same
responses and error codes (`session_not_found`, `project_required`, `engines_failed`, ...). This
keeps discovery pointed at whichever account the user is currently mapping.

---

## 5. Web UI changes

### Home.tsx target card ([web/src/pages/Home.tsx](../../web/src/pages/Home.tsx))

Today the Gemini card shows one email and `+ Add Another` is effectively a no-op because the
backend overwrites. Changes:

- The **All Platforms** target card shows a count from `summary.googleAccounts.length` and lists
  the connected emails; `+ Add Another` runs the same popup connect and, on success, refetches the
  session (now the new account appears instead of replacing the old).
- The **Manage Platforms** target group renders **one row per account** (email, project, SA
  status), each with:
  - a **select control** (radio / "Set as target") calling `POST /api/auth/target/select`; the
    active one is visually marked;
  - a **remove control** (the existing trash icon) calling `disconnect` **with `accountId`**.
- The `web/src/types.ts` `SessionSummary` gains `googleAccounts: GoogleGoogleAccountSummary[]` and
  `activeGoogleId?`, and `web/src/api.ts` gains `selectTargetAccount(session, accountId)` plus an
  `accountId` argument on `disconnectPlatform`.

### Threading the selected target through the wizard

The flow is ChoosePair -> SelectMap -> SelectData -> Migrate. Two clean options:

- **Option A (recommended, minimal): rely on `activeGoogleId`.** SelectMap discovery already hits
  the destination routes, which now default to the active account. The user picks their target on
  Home (or ChoosePair) before mapping; `POST /migrate/plan` snapshots the active account into
  `plan.targetAccount`. Least plumbing; matches the current single-flow UX.
- **Option B (more robust for multi-tab): thread an explicit `targetAccountId`** query param from
  ChoosePair through SelectMap/SelectData into `planMigration(...)`, and pass `&account=` to the
  discovery calls. Removes any dependence on a mutable session pointer.

Recommend shipping **A** first (smallest change, unblocks the user's request) and adding the
explicit param in **B** only if multi-tab retargeting becomes a real support issue. Either way the
run is deterministic because the plan snapshots the target.

A small honesty nicety: show the bound target account (email + project) on the Migrate screen
header so the operator can see exactly which account this run writes to.

---

## 6. Multi-tenant, idempotency, best-effort-persistence implications

- **Multi-tenant isolation — preserved.** `googleAccounts` live *inside* the session document,
  which is already scoped by `appUserId` and looked up by opaque server-side id. No new
  migration-scoped collection and no new query, so there is no new `appUserId` filter to add. Every
  existing scoped query (`migrationRuns`, `migrationResults`, `stagedAgents`, ...) is untouched and
  still filters by `appUserId`. `appUserId` is still derived from the session, never client-supplied.
- **Idempotency — unchanged.** Re-running a migration still keys created agents on display name and
  `agentFiles` on filename ([orchestrator.ts:39-47](../../server/src/orchestrator.ts)). Binding a
  run to a snapshotted target account does not create duplicates; re-running the same plan targets
  the same account and the same idempotent create path.
- **Best-effort persistence — preserved.** The list lives on the session, which already has the
  in-memory `fallback` Map for a Mongo outage ([sessionStore.ts:56-57](../../server/src/sessionStore.ts)).
  The read-time normalizer and the append/select/remove mutations all go through the existing
  `getSession`/`updateSession`/`unsetSessionFields` funnels, which already degrade to memory and
  never throw. The app still boots and migrates with Mongo down (a single held account in memory).

---

## 7. Blast radius / ordered, file-by-file change list

Each step compiles and leaves the app working (`npm run typecheck` green in both `server/` and
`web/`). Ship as 2-3 small PRs along the dashed lines, per
[.claude/rules/pr-standard.md](../../.claude/rules/pr-standard.md) (one pipeline concern per PR).

**PR 1 — data model + read compat (no behavior change yet):**
1. [server/src/types.ts](../../server/src/types.ts) — add `GoogleAccount`, `PlanTargetAccount`;
   add `targetAccount?` to `ResolvedPlan`.
2. [server/src/sessionStore.ts](../../server/src/sessionStore.ts) — add `googleAccounts` /
   `activeGoogleId` to `Session`; keep flat fields deprecated; add the read-time normalizer in
   `toSession()`, `activeGoogleAccount()`, `googleAccountById()`, `syncActiveMirror()`.
   *(App still uses the mirror everywhere, so nothing else breaks.)*

--- ship / verify ---

**PR 2 — connect side (append, select, disconnect-one, summary, discovery):**
3. [server/src/routes/auth.ts](../../server/src/routes/auth.ts) — google callback append/dedupe
   ([:283](../../server/src/routes/auth.ts)); bypass path ([:249](../../server/src/routes/auth.ts));
   session summary returns the list + `activeGoogleId` ([:296-315](../../server/src/routes/auth.ts));
   `POST /target/select`; disconnect accepts `accountId` ([:323-338](../../server/src/routes/auth.ts)).
4. [server/src/routes/destination.ts](../../server/src/routes/destination.ts) — resolve the account
   (optional `&account=`, default active) for projects/engines/validate.
5. [web/src/types.ts](../../web/src/types.ts) — `SessionSummary.googleAccounts` + `activeGoogleId`.
6. [web/src/api.ts](../../web/src/api.ts) — `selectTargetAccount()`; `accountId` on
   `disconnectPlatform()`.
7. [web/src/pages/Home.tsx](../../web/src/pages/Home.tsx) — list/add/select/remove target accounts.

--- ship / verify (user's reported bug is fixed here) ---

**PR 3 — bind the run to the chosen target:**
8. [server/src/routes/migrate.ts](../../server/src/routes/migrate.ts) — `/plan` accepts
   `targetAccountId`, snapshots `plan.targetAccount`.
9. [server/src/orchestrator.ts](../../server/src/orchestrator.ts) — read `project`/`gEmail` from
   `plan.targetAccount` (fall back to active account) at [:159-160](../../server/src/orchestrator.ts).
10. [server/src/services/organizationProfile.ts](../../server/src/services/organizationProfile.ts)
    — read `gEmail`/`project` from the resolved active/target account instead of `session.gEmail`
    / `session.geminiProject` ([:49-73](../../server/src/services/organizationProfile.ts)). (It
    takes a `Session`; pass the resolved account or add an overload — keep it best-effort.)
11. Optional [web/src/pages/SelectData.tsx / Migrate.tsx] — show the bound target; (Option B) thread
    `targetAccountId`.

--- later, its own PR ---

**PR 4 — remove the deprecated flat mirror** once no old client/server remains.

Not touched (verify during review they stay unaware of multi-account): `services/dataverse*`,
`services/mapper.ts`, `services/gemini*` write helpers, `db/repos/*`, `AgentIR`, all
migration-scoped collections.

---

## 8. Explicit callouts

**Needs Architect / product sign-off:**
- **Session-contract change.** Persisted session shape changes (list + active pointer). Recommend a
  one-line entry in [.claude/memory/decisions.md](../../.claude/memory/decisions.md): "Target side
  of a session is now a list of Google accounts + `activeGoogleId`; runs snapshot the target into
  `ResolvedPlan.targetAccount`; flat Google fields deprecated for one release."
- **Product semantics of "target per run".** Confirm the intended model is *one target account per
  migration run* (with easy switching), not *one run fanning out to several accounts at once*. This
  design assumes one-per-run (snapshotted). Fan-out to multiple targets in a single run is a larger
  change (loop the plan per target) and should be a separate decision.
- **Source side stays single-slot.** Confirm Microsoft remains single-account for this feature
  (it defines the tenant/session). Multi-source is out of scope.

**Fidelity / honesty impact:**
- **Net positive, low risk.** The report is per-run and per-agent; nothing about *what* is extracted
  or mapped changes, so no new `FidelityNote` types are needed and nothing is silently dropped.
- **One honesty improvement to include:** print the bound target account (email + project) in the
  run/report header so an operator can never be confused about which account a run wrote to. Guard
  against the (now impossible if we snapshot) case of the report implying a different account than
  was written.
- **Guard rail:** the plan preview and Migrate screen must show the resolved target *before* the
  operator starts the run — silently defaulting to "some active account" would violate
  recommend-don't-decide.

**Open questions:**
1. If the active account's `saOk` is `false`, should `/plan` refuse to bind it (hard stop) or allow
   planning and let the orchestrator abort as it does today ([orchestrator.ts:229-236](../../server/src/orchestrator.ts))? Recommend: allow, but surface `saReason` prominently in the plan preview.
2. Should `environmentMap` entries be validated against the bound target account's project (reject a
   mapping whose `project` differs from `targetAccount.geminiProject`), or is cross-project mapping
   within one connected admin intentional? Needs product input — today `environmentMap` can point
   anywhere the SA can reach.
3. Cap on held accounts per session? Suggest a soft limit (e.g. 10) to bound the session doc size;
   confirm with product.
4. When a held-but-inactive account's `gToken` expires, is a silent "reconnect to browse projects"
   prompt acceptable, or do we want proactive refresh? Recommend silent reconnect (writes use the
   SA, so this only affects discovery).
5. Rollout ordering across a fleet: during PR 2/3 rollout, a *new* server writing the list and an
   *old* server reading only flat fields coexist. The mirror covers old readers; confirm the deploy
   is rolling (not blue/green with long overlap) so the mirror window is short.
