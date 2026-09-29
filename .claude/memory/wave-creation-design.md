# Design: Wave Creation phase (v2 wizard) — Architect sign-off, design-only

Date: 2026-09-25. Status: **approved design, not yet implemented.** No app code was written for
this pass — see [.claude/memory/decisions.md](decisions.md) for the companion log entry.

Reference behavior the customer asked to copy: a reference CloudFuze product's user/file "Wave
Creation" screen (filter-tab row, `+ New wave`, `Assign to wave` bulk action, a WAVE column,
Import CSV, a rescan button, Continue). Only the **interaction shape** is being copied — the
domain here is Copilot Studio **agents**, not users or files, and CS_GE has no equivalent of
that other product's staggered per-wave cutover execution. That gap is the whole reason this
design spends as much time on what NOT to build as on what to build.

---

## Summary

Add a new **Wave Creation** phase to the v2 wizard, sitting between **Select agents** and
**Connectors**. It lets the customer tag each already-selected agent with a wave label
(`Unassigned` by default) using the same filter/bulk-select/pagination/modal patterns
`MapUsersV2.tsx` and `SelectAgentsV2.tsx` already establish. In this iteration a wave is
**purely an organizational tag** — extraction, mapping, create, verify, and the Migrate run
itself are completely unaffected. It touches no pipeline stage; it is metadata that rides
alongside the existing agent selection.

This is a deliberate, honest scope cut. The orchestrator (`server/src/orchestrator.ts`) has
**no batching/sequencing concept of any kind** today — confirmed by reading it, not assumed
(see "What the orchestrator actually does" below). Building real sequenced-wave *execution*
(wave 1 fully completes before wave 2 starts) is a separate, materially larger orchestrator
change and is explicitly deferred, named as future work, not attempted here.

## Architecture

### What the orchestrator actually does today (read, not assumed)

`execute()` in `server/src/orchestrator.ts` builds one **flat** work-list across every
environment in the plan:

```ts
const workItems = plan.units.flatMap((u) =>
  u.bots.map((bot) => ({ envUrl: u.envUrl, envName: u.envName, bot })),
);
```

Both phases run this flat list through `mapPool(items, limit, fn)` — a bounded-concurrency
pool, `CONCURRENCY = 5` for Phase 1 (Dataverse extraction) and `INSERT_CONCURRENCY = 3` for
Phase 2 (Gemini writes). Concurrency means several agents are being extracted/created/verified
**at the same time**, in an order the pool's internal `next++` cursor determines, not a
caller-controlled sequence. There is:

- no `batch`, `wave`, `sequence`, `stage`, or "run in groups" concept anywhere in
  `orchestrator.ts`, `services/scope.ts`, or the `ResolvedPlan`/`MigrationScope`/`ScopeUnit`
  types (`server/src/types.ts:622-716`) — grepped for all of these, zero matches;
- no mechanism to pause between two subsets of a single `runMigration()` call and wait for a
  human "go" signal between them.

`MigrationScope` today has four shapes: `agents`, `environments`, `tenant`, and `selection`
(exact per-env agent picks — `{ kind: 'selection'; units: { env: string; botIds: string[] }[] }`,
`types.ts:631`). `resolveScope()` (`services/scope.ts`) expands any of these into the same flat
`ScopeUnit[]` the orchestrator consumes identically regardless of which scope kind produced it.
A `wave` scope kind (`{ kind: 'wave'; waveId: string }`, resolved by reading the stored
assignment map and filtering to that wave's bot ids) would fit this existing shape cleanly — but
would only let someone **kick off a separate `runMigration()` call per wave manually**, which is
not "sequenced execution" in any real sense (no ordering, gating, or one-wave-then-the-next
guarantee) and is **not part of this design's v1 scope**. It's named here only so a future
design doesn't have to rediscover that the scope-resolution layer already supports it.

**Conclusion for point 1**: Wave Creation is placed right after Select agents (confirmed
correct) and is, in this iteration, a **client-visible, best-effort-persisted label with zero
effect on execution order or the orchestrator's concurrency model**. Migrate ignores it
completely. This is stated to the customer, not hidden — see the UI copy in the screen section
below and the "Fidelity / honesty" note.

### Two-phase boundary impact: none

Wave Creation reads/writes only session-scoped selection metadata before Phase 1 (EXTRACT) ever
starts. It does not touch `stagedAgents`, does not call Dataverse or Gemini, and does not sit on
either side of the EXTRACT/INSERT handoff. No boundary crossing.

### `AgentIR` / DB-schema impact: **no `AgentIR` change; no new Mongo collection.**

Extending the IR was considered and rejected: a wave is a **migration-run planning concept**
("which agents does the customer want tracked together"), not a fact about the source Copilot
agent — it has no business living on the platform-neutral extraction contract. `AgentIR`,
`TopicIR`, and `KnowledgeSourceIR` are untouched.

Data model (detail in the next section): wave state is stored as **two new optional fields on
the existing `Session` document** (`server/src/sessionStore.ts`, collection `migrationSessions`)
— the same collection and the same persistence shape `agentSelection` already uses today. No
new collection, no change to the "9 collections" (now effectively more, see the correction note
below) bootstrapped in `db/mongo.ts`.

**Correction to `.claude/memory/architecture.md` surfaced while researching this design**: that
file states `migrationSessions` has a **TTL of 1h**. Reading `db/mongo.ts:56-62` shows this is
stale — the TTL was **deliberately dropped** in a prior change ("a cloud connection is meant to
persist until the user explicitly disconnects it, so there is no expiry — drop any TTL index
left over from an earlier version of this collection", plus a `dropIndex('createdAt_1')` call).
This matters directly for this design: it means storing wave assignments on the session document
is durable for the life of the connection, not at risk of silently expiring mid-wizard the way a
1h TTL would imply. Recommend `architecture.md`'s collection table be corrected in the same PR
that implements this feature (small, unrelated-to-waves doc fix, called out here so it isn't
missed).

## Data model

Add to `Session` (`server/src/sessionStore.ts`), directly beside the existing `agentSelection`
field:

```ts
/** Wave labels the customer has created for this migration, in creation order.
 *  Purely organizational in this iteration — see wave-creation-design.md. */
waves?: { id: string; name: string; createdAt: string }[];

/** botid -> wave id. Absent entry, or a value not present in `waves`, both mean
 *  "Unassigned" — never a distinct third state to keep the UI's tri-state simple. */
waveAssignments?: Record<string, string>;
```

Why this shape and not a new collection:

- **Same precedent as `agentSelection`**: that field already stores exact-agent-pick state
  (`{ envUrl, envName?, botIds }[]`) directly on the session document and is read/written via
  `getSession`/`updateSession` — the identical mechanism this design reuses. Inventing a tenth
  collection for a second, closely-related piece of per-migration planning state would fragment
  one concept (what's in this run, and how it's organized) across two stores for no benefit.
- **Multi-tenant scoping is inherited, not reinvented**: the session document already carries
  `appUserId` (`sessionStore.ts:26`) and is looked up by its own opaque, server-side-only id —
  exactly the same security posture `agentSelection` already has. No new `appUserId`-filtered
  query pattern needs to be reviewed; it's the existing one.
- **Best-effort persistence is inherited too**: `updateSession()` already degrades the way every
  other repo write does (`db/repos/*`'s `isDbConnected()` guard equivalent for the session
  store) — a Mongo outage means wave tags don't persist between reloads, not that the wizard
  breaks, matching this project's persistence rule.
- **Durable for the life of the connection**: per the TTL correction above, this is not a
  short-lived cache — it will still be there next week, matching how a customer actually plans a
  multi-day migration rollout.
- A **new collection was rejected** because nothing about wave data needs its own indexing,
  its own lifecycle, or to be queried independently of "the session's current plan" — the two
  things that would justify a dedicated `db/repos/waves.ts` module. If a future iteration adds
  real per-wave *scheduling* (a wave with a planned run date, an owner, a status independent of
  the session) that would be the point to promote this into its own collection; that is not
  today's requirement.

`waveAssignments` is keyed by `botid` (not `{env, botid}`) because bot ids are already the
identity `AgentRow`/`agentSelection`/`ResolvedPlan.units[].bots[].botid` use as the unique key
within one migration's scope; there is no observed case in this codebase of the same botid
appearing in two environments within one customer's selection, and every existing per-agent
keyed structure (`agentSurfaceChoice`, `agentConnectorIdentity`, `resolvedPrincipalCache`'s
sibling patterns) already keys off a bare source/bot id for the same reason.

## Server API additions

New endpoints on `migrateRouter` (`server/src/routes/migrate.ts`), directly beside the existing
`GET/POST /api/migrate/selection` pair and following the exact same shape (Zod-free typed-cast +
guard, `error: snake_case` on failure, session resolved via `getSession`):

```
GET  /api/migrate/waves?session=<id>
  -> { waves: {id,name,createdAt}[], assignments: Record<botid, waveId> }

POST /api/migrate/waves            { session, name }
  -> creates one wave, returns { id, name, createdAt }
  -> 400 wave_name_required if name is blank after trim
  -> idempotent-by-name is NOT enforced (two waves may share a name; ids are what matter,
     mirroring how nothing in this codebase enforces unique display names elsewhere either)

POST /api/migrate/waves/assign     { session, botIds: string[], waveId: string | null }
  -> waveId: null means "Unassigned" — an explicit unassign, not "leave whatever it was"
  -> 400 bot_ids_required if botIds is empty or not an array
  -> writes waveAssignments[botId] = waveId for every id (or deletes the key when null)

POST /api/migrate/waves/delete     { session, waveId }
  -> removes the wave from `waves`; every assignment pointing at it is left in place on the
     document but reads back as "Unassigned" per the read-side rule above (dangling ids are
     never a distinct state) — no need for a fan-out unassign write
```

All four resolve `session` via `getSession()` and 404 `session_not_found` exactly like every
other route in this file, per `api-conventions.md`.

## Migrate phase: no change in this iteration

Explicit, so it doesn't get re-litigated by a future implementer optimistically:

- `MigrateV2.tsx` and `orchestrator.ts` are **not touched**. The run still executes the flat,
  bounded-concurrency work-list exactly as it does today, over the full agent selection,
  regardless of wave tags.
- **What would be overclaiming, and is explicitly NOT built now**: a per-wave progress
  breakdown in Migrate ("Wave 1: 4/4 done, starting Wave 2…") would visually imply the run
  executes wave-by-wave. It does not — `INSERT_CONCURRENCY = 3` means agents from different
  waves can easily be mid-flight simultaneously, and there is no code path that waits for one
  wave's agents to finish before starting another's. Showing a per-wave progress UI without
  building actual sequencing underneath it is exactly the "silently decide / overclaim" failure
  mode `CLAUDE.md` and `security-rules.md` both call out — the tool must never look more capable
  than it is.
- **What is honestly deliverable and left as a clearly-scoped future item, not started here**:
  (a) a `wave` `MigrationScope` kind (as noted above, the resolver layer already supports this
  shape trivially) letting a customer manually run one wave's agents as a distinct migration —
  still not "automatic sequencing," just a convenience filter on top of the existing manual
  "run a migration" action; (b) a `wave` column on `ReportRow` (`web/src/v2/data/types.ts`),
  populated by joining a completed run's results against the session's
  `waveAssignments` snapshot at run-start time — cheap and additive, but out of scope for this
  pass since `ReportSource`/`services/report.ts` were not part of the requested design.
  Both are one-paragraph follow-up designs, not started here, and neither requires any change
  to `AgentIR` or the two-phase boundary.

## UI / data shape: `WaveCreationV2.tsx`

New file: `web/src/pages/v2/WaveCreationV2.tsx`, structurally modeled on `MapUsersV2.tsx` (filter
row + toolbar + tick-select + click-row-to-open-picker + standalone pagination footer) crossed
with `SelectAgentsV2.tsx` (the agent row shape, environment/topic/knowledge facts, and reading
the same already-selected scope rather than the whole tenant).

**Scope of rows**: this screen operates on the agents already chosen in Select agents — read via
the existing `source.agents.list(session, envs)` + the session's saved selection (same
`usePairs`/`agents:${session}:${envKey}` cache-key pattern `SelectAgentsV2` already uses),
filtered down to `chosen` bot ids from `GET /api/migrate/selection`. It does **not** re-offer
agents the customer excluded — a wave over agents that aren't in the run would be confusing
organizational noise.

### `web/src/v2/data/types.ts` additions

```ts
// ── waves ───────────────────────────────────────────────────────────────────

export interface WaveDef {
  id: string;
  name: string;
  createdAt: string;
}

/** One selected agent, as the Wave Creation screen needs it — same facts as
 *  AgentRow plus the wave it currently carries. */
export interface WaveAgentRow {
  botId: string;
  name: string;
  env: string;
  envName: string;
  topics: number;
  knowledge: number;
  /** Wave id, or absent for "Not in a wave". A dangling id (its wave was
   *  deleted) reads exactly the same as absent — see the server route note. */
  wave?: string;
}

export interface WavesSource {
  /** Selected agents + their current wave tag, and every wave defined so far. */
  list(session: string): Promise<{ waves: WaveDef[]; rows: WaveAgentRow[] }>;
  /** Create one wave, named by the customer. Returns it so the caller can
   *  immediately assign into it without a second round trip. */
  createWave(session: string, name: string): Promise<WaveDef>;
  /** Delete a wave. Agents tagged with it read back as unassigned — see the
   *  server route's note on why no fan-out write is needed. */
  deleteWave(session: string, waveId: string): Promise<void>;
  /** Assign (or, with waveId null, explicitly unassign) one or many agents. */
  assign(session: string, botIds: string[], waveId: string | null): Promise<void>;
}
```

Add `waves: WavesSource` to `V2Source` (both `api.ts` and `fixture.ts` implement it, same as
every other namespace).

### `web/src/v2/data/api.ts` (real backend)

```ts
const waves: WavesSource = {
  list: (session) => fetchWaves(session), // new wrapper in api.ts, GET /api/migrate/waves
  createWave: (session, name) => postJson(`/api/migrate/waves`, { session, name }),
  deleteWave: (session, waveId) => postJson(`/api/migrate/waves/delete`, { session, waveId }),
  assign: (session, botIds, waveId) => postJson(`/api/migrate/waves/assign`, { session, botIds, waveId }),
};
```

(`postJson` a small shared helper, or inline `fetch` + `.ok` check matching the existing
`saveSelectionToServer`-style wrappers in `web/src/api.ts` — implementer's call, no existing
helper of that exact name was found so either add one or match the inline pattern used
everywhere else in that file.)

### `web/src/v2/data/fixture.ts` (canned data)

In-memory `FIX_WAVES: WaveDef[]` seeded with one or two waves, and a mutable
`Record<string, string>` assignment map, mutated by `createWave`/`assign`/`deleteWave` and
`wait()`-wrapped like every other fixture method — same shape as the existing `agents`/`users`
fixture objects in that file.

### Screen layout

```
v2-canvas-h:      "Wave creation"
                  sub: "Group your selected agents into waves for tracking. Every
                        agent in this run still migrates together — waves are an
                        organizational tag in this release, not a staggered rollout."
                        (explicit honesty per the Migrate-phase section above)

v2-dir strip:     Selected <N> · Waves <N> · Unassigned <N>   (same shape as
                  Select agents' "This run" strip)

Panel:
  SelectBar:
    - search input (filter by agent name)                — same as MapUsersV2's v2-mapsearch
    - "+ New wave"  -> NewWaveModal (name input, Create/Cancel)
    - divider
    - "Assign to wave" (disabled when chosen.size===0)     -> AssignWaveModal, bulk over `chosen`
    - "Import CSV"     -> WaveCsvModal, same explaining-modal-first pattern as MapUsersV2's
                          csvModalOpen (two columns: agent name or bot id, wave name; unmatched
                          rows reported, never silently dropped)
    - "Rescan" (IcoRefresh, spinning while syncing) — re-reads `waves.list()`, labeled
      "Rescan" NOT "Auto Map": there is no matching heuristic here (unlike Map users' real
      auto-match-by-directory logic) — calling a plain re-read "Auto Map" would claim
      intelligence that does not exist. The reference's visual/interaction shape is kept;
      the label is not copied where it would mislead.
    - divider
    - "Select all" / "Clear"                               — same as both existing screens

  Filter tabs (row, above or in place of the v2-rowhead filter-dropdown; tabs chosen over
  MapUsersV2's dropdown because the customer specifically described a tab row, and the count of
  tabs is small and known — one per wave, not one per open-ended value):
    [ All agents (N) ] [ Not in a wave (N) ] [ Wave 1 (N) ] [ Wave 2 (N) ] ...
    Each tab sets `waveFilter: 'all' | 'unassigned' | waveId`.

  v2-tablewrap / v2-rowhead:
    [tick-all]  NAME              ENVIRONMENT       WAVE
    Row (button, data-agent-target=`agent:${botId}`, same as SelectAgentsV2's row target):
      Tick (bulk-select, does NOT open the picker — mirrors MapUsersV2's row-is-a-button-but-
            the-Tick-has-its-own-onToggle split)
      name + "envName · N topics · N knowledge" sub-line (same as SelectAgentsV2's row)
      WAVE cell: Chip tone="muted" "Unassigned"  OR  Chip tone="ok" "<wave name>"
      clicking the row body (not the Tick) opens AssignWaveModal scoped to that one botId
        — same click-row-to-fix pattern as MapUsersV2's AccountPicker

  v2-pagebar (standalone, same as MapUsersV2):
    Total <N>  ·  Unassigned <N>  ·  Waves <N>  ·  Selected <N>       Page X of Y  [rows/page] [<][>]

AssignWaveModal (reuses Modal primitive, list styled like AccountPicker's `.v2-fdd-item` list):
  - "+ Create new wave" inline input at the top of the list (creates then immediately assigns —
    one action, matching the reference's own "+ New wave" being reachable from inside the bulk
    assign flow, not only the toolbar)
  - existing waves as pick rows (IcoCheck on the currently-common one, if the whole bulk
    selection currently shares one wave; blank if mixed — same idea as MapUsersV2's `current`)
  - "Unassign" row (mirrors AccountPicker's "Clear match")
  - footer: Cancel / Assign

NewWaveModal: name input, Create/Cancel, no assignment side effect — for the toolbar's
  standalone "+ New wave" (creating a wave ahead of assigning anyone to it, same as the
  reference's own two entry points into wave creation).

WizardFooter:
  onBack -> /v2/select-agents
  onNext -> /v2/connectors
  nextLabel "Continue to connectors"
  note: no blocking condition — an all-Unassigned run is valid and common (a customer not yet
        ready to organize waves, or one who never will) — never force wave assignment to
        proceed, since a wave is optional metadata, not a precondition for anything downstream.
```

Inspector panel (right rail, same `Inspector`/`InspectorHead`/`InspectorSection` primitives as
both existing screens): counts (waves, unassigned, selected), and a `Note` making the same
honesty statement as the canvas header — this is intentionally repeated in two places, because
it's the single most important thing to not let a customer misunderstand about this screen.

## Rail wiring

**`web/src/components/v2/PhaseRail.tsx`**

```ts
export type PhaseId =
  | 'connect' | 'map-users' | 'select-agents' | 'wave-creation'
  | 'connectors' | 'migrate' | 'report';

export const PHASES: Array<{ id: PhaseId; label: string }> = [
  { id: 'connect', label: 'Connect clouds' },
  { id: 'map-users', label: 'Map users' },
  { id: 'select-agents', label: 'Select agents' },
  { id: 'wave-creation', label: 'Wave creation' },       // NEW — between Select agents and Connectors
  { id: 'connectors', label: 'Connectors' },
  { id: 'migrate', label: 'Migrate' },
  { id: 'report', label: 'Report' },
];

export const OLD_ROUTE: Record<PhaseId, string> = {
  connect: '/connect',
  'map-users': '/map-users',
  'select-agents': '/select-data',
  'wave-creation': '/select-data', // the old (v1) UI has no wave concept at all; falls back to
                                    // the nearest real screen, same convention 'select-agents'
                                    // already uses, rather than a dead link.
  connectors: '/connector-config',
  migrate: '/migrate',
  report: '/migrate',
};

export const BUILT: ReadonlySet<PhaseId> = new Set<PhaseId>([
  'connect', 'map-users', 'select-agents', 'wave-creation', 'connectors', 'migrate', 'report',
]);
```

Plus one new entry in the `ICON` record — a simple "stacked layers/batches" glyph, matching the
existing line-icon style (2.2 stroke, 24x24 viewBox), distinct from `select-agents`' checklist
icon and `connectors`' plug icon.

**`web/src/App.tsx`**

```tsx
import WaveCreationV2 from './pages/v2/WaveCreationV2.tsx';
...
<Route path="/v2/select-agents" element={<SelectAgentsV2 />} />
<Route path="/v2/wave-creation" element={<WaveCreationV2 />} />   {/* NEW */}
<Route path="/v2/connectors" element={<ConnectorsV2 />} />
```

**Adjacent-screen edits required for the new phase to actually sit in the flow** (not optional —
without these the rail shows the phase but navigation skips it):

- `web/src/pages/v2/SelectAgentsV2.tsx`: `onNext` changes from
  `navigate('/v2/connectors?...')` to `navigate('/v2/wave-creation?...')`; `nextLabel` from
  `"Continue to connectors"` to `"Continue to wave creation"`.
- `web/src/pages/v2/ConnectorsV2.tsx`: `onBack` changes from
  `navigate('/v2/select-agents?...')` to `navigate('/v2/wave-creation?...')`.
- `web/src/pages/v2/WaveCreationV2.tsx` (new): `onBack -> /v2/select-agents`,
  `onNext -> /v2/connectors`, as specified above.

No other screen references `select-agents`/`connectors` as a hardcoded neighbor (grepped
`navigate(\`/v2/` across `web/src/pages/v2/`; only the three call sites above touch this pair).

## Implementation Sequence

1. **Types** — add `WaveDef`/`WaveAgentRow`/`WavesSource` to `web/src/v2/data/types.ts`; add
   `waves: WavesSource` to `V2Source`. Add `waves?`/`waveAssignments?` to `Session` in
   `server/src/sessionStore.ts`.
2. **Server routes** — add the four `/api/migrate/waves*` endpoints to
   `server/src/routes/migrate.ts`, beside the existing `/selection` pair, following the same
   `getSession` + typed-cast + `snake_case` error convention. No new repo module — reads/writes
   go through `getSession`/`updateSession` exactly like `agentSelection` does today.
3. **`web/src/api.ts`** — add `fetchWaves`/`createWaveOnServer`/`deleteWaveOnServer`/
   `assignWaveOnServer` thin wrappers, matching the file's existing wrapper style
   (throw a plain `Error(<code>)` on non-OK).
4. **`web/src/v2/data/api.ts`** — implement the real `waves: WavesSource` object using the
   step-3 wrappers.
5. **`web/src/v2/data/fixture.ts`** — implement the fixture `waves: WavesSource` with an
   in-memory `FIX_WAVES` array and mutable assignment map.
6. **`WaveCreationV2.tsx`** — build the screen per the "UI / data shape" section above, reusing
   `SelectBar`, `Tick`, `Modal`, `Chip`, `Panel`, `Inspector*`, `WizardFooter`,
   `SkeletonRows`, `NoteRow` from `components/v2/primitives.tsx` (no new primitives needed —
   confirm during implementation that the filter-tab row doesn't need a new primitive beyond
   plain buttons + the existing `Chip`/tab styling already used for `v2-fdd-item` lists).
7. **Rail wiring** — `PhaseRail.tsx` (`PhaseId`, `PHASES`, `OLD_ROUTE`, `BUILT`, one new icon)
   and `App.tsx` (`import` + `<Route>`), per the exact diffs above.
8. **Adjacent-screen navigation edits** — `SelectAgentsV2.tsx`'s `onNext`/`nextLabel` and
   `ConnectorsV2.tsx`'s `onBack`, per the exact diffs above. **Do this in the same PR as step 7**
   — merging the rail/route addition without these leaves a reachable-but-orphaned screen
   (rail links to it, but the wizard's own Continue/Back buttons skip around it), which is worse
   than not shipping the phase at all.
9. **Typecheck** — `npm run typecheck` in both `server/` and `web/` (mandatory per
   `pr-standard.md`), then a manual `/qa` pass over the new screen's filter tabs, bulk assign,
   CSV import, and the Back/Continue chain across all three touched screens.
10. **Doc correction** (small, bundle into the same PR or a follow-up doc-only PR): fix
    `.claude/memory/architecture.md`'s "9 collections... TTL 1h" claim for `migrationSessions`
    per the correction noted above, and add "waves / waveAssignments" to its `Session` field
    description if that file documents session fields elsewhere (it currently documents
    collections, not per-field detail, so this may be a one-line addition or a no-op — check
    the file's actual level of detail before adding to it).

## Notes

**Fidelity / honesty impact**: This feature does not touch the fidelity pipeline (mapping,
`FidelityNote`s, verification, or the report) at all in this iteration — there is nothing to
overclaim about migration *quality*. The overclaiming risk here is entirely about **execution
semantics**: a wave-labeled UI must not imply staggered/sequenced execution that does not exist.
Every customer-facing string proposed above (`canvas-h` sub-line, inspector `Note`, the
"Rescan" vs "Auto Map" label choice) is written to say this plainly rather than let the UI's
resemblance to a real-batching product carry an implication the backend doesn't back up.

**Migration safety / backward compatibility**: Purely additive. Sessions created before this
ships simply lack `waves`/`waveAssignments` and behave exactly as today (every agent reads as
"Unassigned", which is the correct default, not a degraded state). No `AgentIR` shape changed,
no existing collection's document shape changed beyond two new optional `Session` fields, no
migration of existing data required.

**Open questions / left for implementation-time judgment, not blocking this design**:
- Exact route/endpoint naming (`/api/migrate/waves` vs. a dedicated `waveRouter`) — kept under
  `migrateRouter` here since waves are migration-planning state exactly like `/selection`, but
  an implementer could reasonably split it out; either is fine and neither is an architectural
  decision requiring a second design pass.
- Whether "Assign to wave" and the row-click picker should write immediately (as designed above,
  matching the reference product's snappy bulk-action feel and this project's existing
  `agentSurfaceChoice`-style immediate-write precedent) versus buffering into a local draft
  applied only on Continue (`MapUsersV2`'s pattern for user-mapping corrections). Recommended:
  **immediate write** — a wave tag has no "wrong until confirmed" risk the way a user mapping
  does (misdirecting agent ownership), so the extra safety of a draft buffer isn't earning its
  complexity here. Flagged as a judgment call, not a blocking question.
- Icon artwork for the rail's new `wave-creation` entry is described (stacked-layers glyph) but
  not drawn — cosmetic, implementer's call within the existing line-icon style.

**Decision to record**: see the companion entry in
[.claude/memory/decisions.md](decisions.md) (dated 2026-09-25) summarizing this design's
additive `Session` fields and the explicit non-decision to leave real wave *execution
sequencing* out of scope.
