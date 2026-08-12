# Memory: Architectural Decisions

Dated log of decisions that shape CloudFuze Studio Migrate. Add an entry (newest first) whenever
you change the `AgentIR` shape, the DB schema, the phase model, the auth model, or the `.claude/`
scaffold. Format: **date — decision — why — impact**.

---

## 2026-08-08 — Close the `/api/auth/resume` orphan gap; two Connect Platforms UX fixes

- **Decision**: Three follow-ups to the same day's earlier disconnect-flow fix. (1)
  `sessionStore.ts`'s `findLatestConnectedSession` now matches a session with **either**
  `dvToken` (Microsoft) **or** `gEmail` (Google) present, not `dvToken` alone — closes the
  known limitation flagged in the entry above: a `google_only` doc (Microsoft disconnected,
  Google survives) was invisible to `GET /api/auth/resume`, so a hard refresh or fresh login
  silently lost track of the still-connected Gemini side. (2) `Home.tsx`'s "← Back" button
  (which called `navigate('/')`, landing on the real Login/Sign-In screen) is removed —
  Connect Platforms is the first step after login, so there's no earlier wizard step to
  return to, and the header's "Sign out" already covers intentionally leaving the app. (3)
  The "Connect Copilot Studio (source) to proceed" banner, shown whenever the source isn't
  connected, is restyled from a red/alarm banner (`.warn-banner`, now renamed
  `.notice-banner`) to a neutral blue informational one — this is an expected "one more step"
  state, not an error condition. New `IcoInfo`/`IcoLogout` icons added to `icons.tsx`
  (replacing the warning-triangle icon on the notice banner and the `⎋` glyph on the header's
  Sign out button, respectively).
- **Why**: user-reported, live-observed UX issues after testing the earlier disconnect fix:
  disconnecting one platform and then hard-refreshing/re-logging-in looked like BOTH
  connections were lost even though only one was ever disconnected (the resume-gap this was
  already flagged as, now actually fixed); the Back button unexpectedly dropping the user on
  what looks like a logged-out screen mid-workflow; and the red warning banner reading as an
  error rather than a normal in-progress state.
- **Impact**: No `AgentIR`/schema-shape change — `findLatestConnectedSession`'s query is
  broader but additive (a `$or`, not a new field). No other caller of `warn-banner` existed
  (grepped before renaming), so the CSS rename is safe. `IcoWarn` remains in `icons.tsx`
  (unused by this page now, kept in case another surface still wants a real warning triangle).
## 2026-08-08 — Disconnecting the Microsoft source no longer deletes a surviving Google connection

- **Decision**: `POST /api/auth/disconnect` for `platform: 'microsoft'` no longer unconditionally
  `deleteSession()`s the whole document. It now unsets only the Microsoft-side fields (`tenantId`,
  `orgName`, `msEmail`, `refreshToken`, `dvToken`, `dvDelegatedToken`, `dvOrgUrl`, `environments`,
  `botCount`, `topicCount`, `ksCount`, `flowCount`). If the doc still has `gEmail` (Google/Gemini
  survives), the doc is kept alive with `step: 'google_only'` and the response reports
  `sessionEnded: false`; the doc is only deleted (`sessionEnded: true`, unchanged behavior) when
  nothing is left connected at all. To make this durable across a reconnect, `GET /microsoft/start`
  now accepts an optional `?session=` and threads it through the signed OAuth state
  (`msSessionId`, mirroring the pattern Google's OAuth leg already used in the other direction);
  `msCallback` re-attaches to that existing session doc via `updateSession` instead of always
  minting a new one via `createSession`. `web/src/pages/Home.tsx`'s `confirmDisconnect()` no longer
  treats "microsoft disconnected" as automatically meaning "navigate away to a blank connect
  screen" — it only does that when `sessionEnded` is true; otherwise it refreshes the session
  summary in place (same as the existing Google-disconnect path), so "Manage Platforms" correctly
  keeps showing Gemini Enterprise as connected. The disconnect confirmation dialog's copy for
  Microsoft now branches on whether Google is still connected.
- **Why**: user-reported UX bug — disconnecting only Copilot Studio (source) was wiping the
  Google/Gemini connection too and resetting the whole "Connect Platforms" screen to "No platforms
  connected yet," even though the user only asked to disconnect one side. Root cause: the session
  document was the sole owner of BOTH platforms' credentials, and "disconnect source" was
  implemented as "delete the whole tenant context." An `architect` design pass confirmed no other
  route/consumer assumed a session doc must always have `dvToken` to exist, so decoupling the two
  platforms' lifecycles on the same doc was safe without a bigger schema split.
- **Impact**: `Session.step` (already a free-form string, no other code branches on specific
  values) gains one new legal value, `'google_only'` — additive, non-breaking. No `AgentIR`
  impact; this is entirely pre-pipeline (auth/session). **Known, accepted limitation, not fixed in
  this pass**: `GET /api/auth/resume` (used to resume the last connected session on login) queries
  `{ appUserId, dvToken: { $exists: true, $ne: '' } }` — a surviving `google_only` doc has no
  `dvToken` and won't be picked up by it. Practically harmless as long as the same browser tab
  stays open (the session id lives in the URL), but if the user logs out/closes the tab before
  reconnecting Microsoft, that doc becomes silently unreachable (orphaned, holding a live Google
  refresh token) rather than resumed. Not fixed here because broadening that query changes what
  "latest connected session" means for the login-resume flow generally — a separate decision, not
  a drive-by tweak. Also considered and **rejected**: splitting the session doc into independent
  per-platform collections (fully decoupled lifecycles) — bigger diff touching every route that
  reads flat `session.gToken`/`session.dvToken`, and multi-tenant `appUserId` scoping isn't wired
  to real login yet anyway (`DEFAULT_APP_USER_ID` is still a placeholder everywhere) — revisit once
  real per-user login lands.

---

## 2026-08-05 — Fix low-code path granting googleSearch regardless of source webBrowsing capability

- **Decision**: `mapper.ts`'s `tools: [{ name: 'googleSearch' }]` (was unconditional for every low-code
  agent) is now `ir.capabilities?.webBrowsing ? [{ name: 'googleSearch' }] : []` — mirroring the
  fidelity note three lines above it (`if (ir.capabilities.webBrowsing) { notes.push({component:
  'webBrowsing', status: 'mapped', ...}) }`), which was ALREADY correctly conditioned, and matching
  `adkDeployer.ts`'s `buildAdkSpec` (`if (ir.capabilities?.webBrowsing) tools.push('googleSearch')`),
  which was also already correct — this was specifically a low-code-path bug.
- **Why**: found while auditing the ADK multi-store fix for hardcoded values, at the user's direct
  request ("is this production grade fix, is there any hardcoding"). A source Copilot agent WITHOUT
  web browsing enabled was silently granted it after migrating to low-code — a real, live fidelity
  mismatch (over-granting a capability), and the exact kind of "hardcoded, doesn't reflect the actual
  source" bug the question was asking about, just in a different file than the one being audited.
- **Impact**: no `AgentIR` shape change. An agent with zero source-side tools now correctly gets
  `tools: []` on the low-code path (confirmed safe: `gemini.ts`'s `buildCreateBody` just passes it
  through as `selectedTools: { tool: [] }`, a valid empty-tools shape, not an error case).

## 2026-08-05 — Correction to the engine-wide/per-agent knowledge-scoping assumption (low-code)

- **Finding** (research, not yet acted on in code): a `researcher` subagent pass, live-checking
  Google's official docs, confirmed the engine-level `dataStoreIds` pool mechanism
  (`attachDataStoreToEngine`) is real (docs.cloud.google.com/gemini/enterprise/docs/apps-data-stores:
  "Apps have a many-to-many relationship with data stores... blended search", 50-stores/app limit)
  — but corrected the "engine-wide only, no per-agent scoping exists" assumption used throughout this
  week's fixes. Google's Console **does** expose a per-agent data-source toggle, separate from the
  engine-level pool: "Manage your data" (prompt-based agent creation) / "Add data sources & tools"
  (flow-builder agent creation) — docs.cloud.google.com/gemini/enterprise/docs/agent-designer/create-agent.
  This lets a human narrow which of an app's engine-attached stores one specific agent actually
  searches. **CS_GE's pipeline never sets whatever field this Console control writes** — confirmed by
  reading `gemini.ts`'s `buildCreateBody`: `selectedTools.tool` only ever contains a bare
  `{"name":"googleSearch"}` entry (see fix directly above), never a data-store-scoped tool entry. So
  a Console-created low-code agent COULD be narrower than an API-created one — an expected,
  explainable divergence between manual and automated agents, not a bug in either.
- **Not yet verified**: the exact REST/proto field "Manage your data" persists to (attempted via
  docs.cloud.google.com's REST reference, blocked by JS-rendered pages `WebFetch` can't read) — per
  this project's "don't guess at unverified Google behavior" discipline, this is flagged unverified,
  not assumed. **Recommended before relying on this further**: a `_diag_*.ts` probe — create a
  low-code agent via Console with 2 engine-attached stores, toggle one off via "Manage your data",
  `GET` the `Agent` resource via the same v1alpha API this codebase already uses, and diff its JSON
  against an agent with both enabled, to find the actual field.
- **Impact**: none yet (research only) — carried here so the next person to touch low-code tool
  wiring knows engine-wide sharing isn't necessarily the ONLY lever, even though it's the only one
  this pipeline currently sets.

---

## 2026-08-05 — SUPERSEDED same day: real ADK multi-store fix — hand-rolled, distinctly-named FunctionTools

- **Decision**: replaces the single-source cap immediately below (superseded, not deleted, so the
  investigation trail stays intact). `scripts/adk_deploy.py`'s `_make_search_tool` now builds ONE
  `FunctionTool` per grounding data store, each wrapping a closure that calls
  `discoveryengine_v1beta.SearchServiceClient.search()` directly (mirroring
  `DiscoveryEngineSearchTool._do_search`, including its CHUNKS-first/DOCUMENTS-fallback
  auto-detection for structured vs. unstructured stores) — instead of N `VertexAiSearchTool`
  instances combined via `bypass_multi_tools_limit`, which a `researcher` subagent investigation
  confirmed is a genuinely unfinished area of `google-adk` upstream (open issues
  [#3146](https://github.com/google/adk-python/issues/3146) and
  [#3406](https://github.com/google/adk-python/issues/3406) — `DiscoveryEngineSearchTool`'s function
  name is hardcoded with no override, confirmed unchanged on `google/adk-python@main`, not a version
  lag in this project's installed 2.5.0). Each closure's `__name__` is set explicitly before
  wrapping, so the `FunctionDeclaration` sent to Gemini is genuinely distinct per store — the
  collision is structurally impossible this way. Two more issues surfaced and were fixed in the same
  pass, both live-verified via a zero-quota-cost method (`deployReasoningEngine` alone, never
  registered — Reasoning Engine deploy and Discovery Engine agent registration are separate APIs;
  only the latter spends this project's scarce ~7/day undocumented quota, see
  `docs/SUPPORT-TICKET-AGENT-QUOTA.md`):
  1. The closure must NOT capture a pre-built `SearchServiceClient` — Agent Engine deployment
     pickles the whole agent (including tools) to ship it to the cloud, and a live gRPC client
     (open credentials/channel state) isn't picklable (confirmed: deploy itself failed with "Failed
     to serialize agent engine" until the client was moved to build fresh inside the search
     function on every call, capturing only the plain `serving_config` string).
  2. The SharePoint-connector store in this pipeline is a structured data store and rejects CHUNKS
     mode outright (`400: content_search_spec.search_result_mode must be set to
     ...DOCUMENTS when the engine contains structured data store`) — fixed by porting
     `DiscoveryEngineSearchTool`'s own CHUNKS-try-then-DOCUMENTS-retry pattern.
  Considered and **rejected**: `search_engine_id` + `data_store_specs` (Vertex AI Search's own way to
  scope one tool across several stores) — confirmed via the same researcher investigation (citing
  `google.genai.types`' own docstring: "only considered for Engines with multiple data stores") that
  it requires the target stores to already be attached to a shared Engine resource, which would
  reintroduce the exact engine-wide (not per-agent) sharing this whole knowledge-parity effort exists
  to avoid.
- **Why**: user pushed back correctly that an enterprise migration tool should ground on ALL of an
  agent's knowledge sources, not silently cap at one — the single-source cap was a same-day stopgap,
  not an acceptable end state.
- **Impact**: no `AgentIR`/DB schema change. Live-verified end-to-end with 2 real, different-kind
  data stores (an uploaded-file document store + the SharePoint-connector structured store) combined
  on one agent: all three test questions (including an unrelated control question) answered
  correctly with proper source citation, zero crashes, zero quota spent verifying it. The
  single-source cap in `orchestrator.ts` (immediately below in this log) has been fully reverted —
  `groundingDataStores` once again combines every resolved source unconditionally, matching the
  original 2026-08-04 knowledge-parity fix's intent.

## 2026-08-05 — Cap ADK grounding at ONE knowledge source per agent (temporary, until multi-store is fixed) — SUPERSEDED same day, see entry above

- **Decision**: `orchestrator.ts`'s ADK closure now picks at most ONE grounding candidate — uploaded
  files first, then Dataverse/SharePoint connector sources, then a website source — and passes only
  that one into `publishAgentToGallery`. Every other resolved-but-excluded source gets an honest
  `needs-review` `FidelityNote` ("not connected yet... only one source can be grounded per agent until
  [the multi-source crash] is fixed... re-run once the multi-source fix ships") instead of being
  silently dropped or, as before this change, crashing the whole agent.
- **Why**: live-confirmed 2026-08-05 (via a throwaway, zero-quota-cost deploy — `deployReasoningEngine`
  alone, never registered, so no agent-creation quota spent verifying this): combining 2+ grounding
  data stores on one ADK agent — even after the `data_store_specs` fix and the
  `google-cloud-discoveryengine` requirements fix immediately above — still crashes on EVERY query,
  including ones needing no knowledge lookup at all, with `400 INVALID_ARGUMENT: "Duplicate function
  declaration found: discovery_engine_search"`. Root cause: ADK's `bypass_multi_tools_limit` wraps
  each `VertexAiSearchTool` instance into a tool registered under the same fixed function name
  (`discovery_engine_search`) — 2+ instances always collide, unconditionally. This is a real SDK
  limitation, not something fixable by more careful use of `VertexAiSearchTool`/`bypass_multi_tools_
  limit` from the outside — the real fix needs a dedicated per-agent Discovery Engine search resource
  so ONE tool can span multiple stores (`search_engine_id` + `data_store_specs`, using a real Engine
  resource scoped to just that agent, not the shared Gemini Enterprise app engine) — not built yet.
  User's explicit call: ship single-source now (uploaded files prioritized first) rather than block
  every multi-source agent on the bigger fix.
- **Impact**: no `AgentIR`/DB schema change. An agent with 2+ knowledge sources now deploys
  successfully and actually works for its ONE selected source, instead of deploying successfully but
  failing every query (the state `KB-Grounding-Test-Agent` was in before this change). Real,
  acknowledged fidelity loss for the excluded source(s) — reported honestly, not hidden. Follow-up:
  design the dedicated-per-agent-search-resource fix properly (architect pass recommended, same as
  the earlier knowledge-parity and ADK-first decisions) before removing this cap.

## 2026-08-05 — Fix ADK multi-store query-time crash: add `google-cloud-discoveryengine` to deploy requirements

- **Decision**: `scripts/adk_deploy.py`'s `agent_engines.create(...)` call now includes
  `google-cloud-discoveryengine` in `requirements` whenever `groundingDataStores` is non-empty.
- **Why**: the multi-store fix immediately below (`bypass_multi_tools_limit=True`) makes ADK wrap
  `VertexAiSearchTool` as a `DiscoveryEngineSearchTool` whenever multiple tools are present — but only
  at QUERY time, not deploy/construction time (confirmed by reading `llm_agent.py`'s
  `_convert_tool_union_to_tools` and reproducing locally: `Agent(...)` builds fine either way, the
  conversion only runs inside request processing). `DiscoveryEngineSearchTool` does `from
  google.cloud import discoveryengine_v1beta`, a module the existing requirements
  (`google-cloud-aiplatform[agent_engines,adk]`, `google-adk`) don't pull in. Live-confirmed
  2026-08-05: after the multi-store fix shipped, a real 2-knowledge-source agent
  (`KB-Grounding-Test-Agent`) deployed successfully (`deployed=true, shared=true, verified=true`) but
  then failed on **every single query**, including one needing no tool at all ("What is the capital
  of France?"), with `ImportError: cannot import name 'discoveryengine_v1beta' from 'google.cloud'` —
  the same import fails locally too until `pip install google-cloud-discoveryengine` (0.20.2) is run.
- **Impact**: the already-deployed agent from before this fix is unrecoverable as-is (a Reasoning
  Engine's requirements are baked in at deploy time; no way to patch a running one) — its cached
  `adkDeployments` record and `migratedAgentSnapshots` snapshot were cleared, and its registered
  agent (`1238471887308860960`) deleted, so the next migration run deploys fresh with the fix instead
  of drift-detection correctly-but-unhelpfully seeing "no source change" and skipping. Its orphaned
  Reasoning Engine (`reasoningEngines/4888500715103715328`) still needs manual `gcloud` deletion — no
  automated cleanup exists for that yet (same known gap as the 2026-08-04 ADK-first decision).

## 2026-08-05 — Fix ADK multi-store grounding: one VertexAiSearchTool per store, not `data_store_specs`

- **Decision**: `scripts/adk_deploy.py` no longer tries to combine 2+ grounding data stores into a
  single `VertexAiSearchTool` via `data_store_specs`. Confirmed by reading the installed `google-adk`
  2.5.0 source directly (`vertex_ai_search_tool.py`'s constructor): it requires **exactly one** of
  `data_store_id` or `search_engine_id` — never neither, never both — and raises `"Either
  data_store_id or search_engine_id must be specified"` otherwise. `data_store_specs` is not an
  alternative way to specify stores; it's a scoping filter valid only *alongside* `search_engine_id`
  (an actual Discovery Engine "engine" resource), which this pipeline deliberately doesn't want to
  require here (it would mean searching a whole shared engine instead of the specific per-agent
  stores this pipeline resolved — the same fidelity point the 2026-08-04 knowledge-parity fix was
  built around). Fixed by building ONE `VertexAiSearchTool(data_store_id=..., bypass_multi_tools_
  limit=True)` per grounding data store instead, so N stores become N tool instances. Verified live
  (not just read): constructed two `VertexAiSearchTool` instances against fake resource paths and
  built a full `Agent` with both — no error, matching the exact failure shape a real 2-source agent
  hit in production (`KB-Grounding-Test-Agent`, 2026-08-05: `"tool wiring failed: Either
  data_store_id or search_engine_id must be specified."`, ADK failed, fell back to low-code, agent
  stayed Private).
- **Why**: this was a deterministic bug, not a flaky one — it fails for EVERY agent with 2+ knowledge
  sources needing ADK grounding, discovered because `KB-Grounding-Test-Agent` was the first agent in
  this whole investigation to actually have 2 (a SharePoint connector + an uploaded file). Every
  earlier live verification this week happened to use only 1 grounding source, so this never surfaced
  until a real multi-source production agent hit it.
- **Impact**: no `AgentIR`/DB schema change, Python-script-only. Also surfaced a bigger, separate
  finding worth its own follow-up: `bypass_multi_tools_limit=True` (confirmed in
  `llm_agent.py`'s `_convert_tool_union_to_tools`) lets ADK auto-wrap `VertexAiSearchTool` as a
  `DiscoveryEngineSearchTool` when multiple tools are present, instead of rejecting the combination —
  meaning the "ADK can't combine VertexAiSearchTool with googleSearch, pre-1.16 limitation" comments
  and the `googleSearchDropped` fidelity note added in the 2026-08-04 knowledge-parity fix describe a
  limitation this installed ADK version (2.5.0) may no longer actually have. **Not fixed in this
  pass** — `adk_deploy.py`'s `tools`/grounding branches are still mutually exclusive (`elif`), so
  googleSearch still gets dropped whenever any grounding store is present, and the fidelity note
  still fires. Confirming and wiring the actual combination is separate, deliberately out-of-scope
  work here — this pass only fixes the deterministic multi-store crash that was blocking real agents.

---

## 2026-08-05 — Detect source drift on re-run; redeploy ADK agents only when changed

- **Decision**: re-running a migration against an agent that already has a recorded ADK deployment
  now compares the freshly-extracted `AgentIR` against a snapshot of the last confirmed-successful
  sync (new `services/driftDetector.ts` — pure, `snapshotFrom`/`detectDrift` over a narrow field
  subset: instructions, description, starter prompts, web-browsing/code-interpreter capabilities,
  and the knowledge-source set — deliberately excluding `sourceMetadata`, which churns on any
  Dataverse save including no-op edits, and `topics`, which has no live Gemini-side artifact to
  redeploy for). New `db/repos/migratedSnapshot.ts` (collection `migratedAgentSnapshots`, same
  composite-key shape as `adkDeployments.ts`) stores that snapshot, written only on a confirmed
  successful ADK deploy — kept deliberately separate from `agentIRCache`, which is overwritten
  unconditionally during Phase-1 extraction and so can never answer "what did we last actually
  migrate." No drift → same cheap skip as before (no redeploy, no quota spent). Drift found →
  falls through to the same deploy path a fresh agent uses, so the ADK agent actually picks up the
  change; `recordAdkDeployment`/`saveMigratedSnapshot` both get overwritten with the new state.
  Agent existed before this feature shipped (ADK deployment recorded, no snapshot yet) → primes a
  baseline and reports `needs-review`, does NOT guess "changed" and redeploy speculatively.
  Low-code agents get no update path in this pass — no confirmed Discovery Engine API exists to
  patch a `lowCodeAgentDefinition` in place, and this project doesn't guess at unverified endpoints
  (same discipline as `geminiConnector.ts`'s `setUpOneDriveConnector`); a low-code-only agent that
  drifts still just gets today's plain "already exists — skipped."
- **Why**: user asked directly — re-running a migration after editing the source agent (say, its
  instructions) should update the destination, not silently do nothing, but also shouldn't blindly
  redeploy every re-run regardless of whether anything changed (ADK redeploys spend the same scarce,
  ~7/day undocumented quota as a fresh create — see `docs/SUPPORT-TICKET-AGENT-QUOTA.md`). User's own
  framing: "if changes detected then only redeploy otherwise skip" — no opt-in flag, unconditional
  once drift is real.
- **Impact**: no `AgentIR` shape change. One new additive collection, no change to existing ones.
  **Known, unresolved risk carried over from the earlier ADK-first decision, now more likely to
  matter**: a drift-triggered redeploy mints a brand-new, separately-billed Reasoning Engine with no
  confirmed way to retire the old one (no `deleteReasoningEngine`-equivalent exists in
  `adkDeployer.ts`) — the fidelity note says so plainly every time a redeploy happens, but nothing
  automatically cleans up the orphan yet. Worth fixing before this sees real, repeated re-run volume.

---

## 2026-08-05 — Try ADK before low-code, not after (low-code becomes the last-resort fallback)

- **Decision**: `orchestrator.ts` no longer attempts low-code (`createAgent`) creation first. It goes
  straight to the ADK/Reasoning-Engine path; `createAgent` (low-code) is now called ONLY if the ADK
  deploy+register attempt itself fails, as a last-resort consolation so the customer still gets a
  (Private) agent instead of nothing. The `lowCodeSkippedForEdition` check
  (`dest.edition === 'standard' || 'plus'`) and the `needsAdkFallback`/`cleanupOrphanedLowCodeAgent`
  machinery built around "try low-code first, delete it if ADK replaces it" are removed — there's
  nothing to clean up when nothing was created ahead of ADK. `GeminiDestination.edition` is left in
  `types.ts` (harmless, no other reader currently), just no longer read by this decision.
- **Why**: per `.claude/memory/gemini-editions-agent-visibility.md`, NO Gemini Enterprise edition
  auto-lists an API-created low-code agent — Business's "self-serve manual publish button" is a human
  console click this automated pipeline never performs. So the low-code attempt, tried first, could
  NEVER reach `ENABLED` and ADK fallback fired anyway, every time — confirmed empirically 2026-08-05
  (every low-code-created agent in this project's Gemini gallery shows `Private`, zero exceptions
  across many runs and many days). That means the low-code attempt was always a wasted
  agent-creation quota unit, and this project's real quota is tiny and undocumented (~7/day,
  empirically measured — see `docs/SUPPORT-TICKET-AGENT-QUOTA.md`) plus a wasted follow-up
  cleanup-delete call once ADK replaced it. User asked directly for this after noticing the pattern
  in the Gemini console (every "Employee-made" row Private, only "Agent Engine" rows Enabled).
- **Impact**: no `AgentIR`/DB schema change. Behavior-preserving for the FINAL outcome — ADK already
  won 100% of the time in this project before this change (low-code never reached `ENABLED`), so no
  agent that would have ended up ADK-backed before now ends up low-code-backed, or vice versa. What
  changes: roughly half the agent-creation quota spend per agent in the common case (ADK succeeds
  outright — no low-code attempt, no cleanup-delete), and one fewer API round-trip per agent.
  **Not addressed here, flagged as a real, separate decision**: this makes ADK (billable, always-on
  Reasoning Engine per agent) the de facto default path for every migrated agent, since low-code is
  no longer tried as the "free" first attempt — `adkDeployer.ts`'s own header comment still says ADK
  is "OPT-IN per agent (billable), NOT the default," which this change is now in tension with (in
  practice, on THIS project, ADK was already the outcome for every agent before this change too — but
  a customer who explicitly wants to avoid ADK's cost and is fine with Private-only agents has no way
  to opt out of the attempt today). Worth a real product decision if/when that matters, not something
  to silently resolve further here.

---

## 2026-08-05 — Keep SA_SCOPES = cloud-platform only (Directory scopes separate)

- **Decision**: Revert bundling Admin Directory scopes into `SA_SCOPES`. Gemini/DWD
  migration tokens use `cloud-platform` only again. Directory reads use
  `getDirectorySaToken()` / `SA_DIRECTORY_SCOPES`. Engines list tries SA then falls
  back to admin OAuth (same token as `hasGeminiApp` probe).
- **Why**: Mixing Directory scopes into the shared SA JWT broke engine listing for
  DWD setups that only authorized cloud-platform — UI showed "No apps in this project"
  even though projects (and prior migrates) worked.
- **Impact**: `config.ts`, `auth/google.ts`, `destination` engines route, SelectMap
  no longer caches empty engines forever; shows warning + Retry.

## 2026-08-04 — Enterprise identity map + permission handoff (agent-touched principals)

- **Decision**: Discover and map **agent-touched** principals only (owners, record shares,
  chat-access groups) — not full Entra/Workspace dumps and not "Copilot Studio licensed users
  only" (Microsoft docs: chat users need no Studio license). Persist overrides in
  `identityMappings`. At INSERT: org-wide chat → `shareAgent(ALL_USERS)`; narrower → do **not**
  silently over-share; emit `PermissionHandoff` + `needs-review` (Gemini has no per-principal
  agent share API). Absent `AgentIR.permissions` keeps legacy ALL_USERS behavior.
- **Why**: CloudFuze-style enterprise migration; honesty over overclaiming; official MS/Google
  licensing and share models.
- **Impact**: Additive `AgentIR.permissions`, `MigrationResult.permissionHandoff`, collection
  #14, `/api/identity/*`, wizard step `/map-users`, SA Directory readonly scopes for dropdown.
  ADK path still registers ALL_USERS — handoff warns when source was narrower.

## 2026-08-04 — Resolve Dataverse-snapshot/SharePoint-connector knowledge BEFORE the low-code/ADK decision

- **Decision**: `orchestrator.ts` now resolves every `dataverse-snapshot` and `sharepoint-connector`
  knowledge source into a built Discovery Engine data store (`resolveDataverseSnapshotSources`,
  `resolveSharePointConnectorSources` — new local functions) *before* deciding low-code vs. ADK,
  instead of resolving+attaching them unconditionally *after* agent creation via
  `attachDataStoreToEngine` only. `attachDataStoreToEngine` is engine-scoped — it only feeds the
  low-code path's search grounding; an ADK/Reasoning-Engine agent's `VertexAiSearchTool` never
  consults it, it only queries resource paths baked in at deploy time. Because resolution used to
  run after creation with no path awareness, an agent that fell back to ADK (low-code stuck
  `PRIVATE`) got a fidelity note claiming its SharePoint/Dataverse knowledge was "attached," but the
  deployed agent could never actually retrieve from it — `verify.ts` didn't catch this because it
  only probes that the agent responds, not that a specific source is retrievable.
  `adkDeployer.ts`'s `publishAgentToGallery` opt `fileGroundingDataStores` is renamed
  `groundingDataStores` (now carries file **and** Dataverse/SharePoint resource paths — ADK combines
  all of them onto one `VertexAiSearchTool` regardless of origin). `migrateDataverseSnapshot`
  (`knowledgeDataStoreExecutor.ts`) no longer calls `attachDataStoreToEngine` itself — it only
  resolves/builds the store now; the caller decides how to attach based on which path won. Its data-
  store naming key changed from the destination agent's id (didn't exist yet at resolve time) to the
  stable Copilot `sourceId` (botid) — a one-time naming change; any table-snapshot data store built
  under the old `agentId`-based name before this shipped is now orphaned (acceptable: this codebase
  is still at test-tenant stage, confirmed zero real customer migrations use this path yet).
  Considered and **rejected** (over-engineering for this fix's actual scope): a full
  "Knowledge Manifest" type with per-entry resolution-status enums and a generalized
  deployment-adapter abstraction (from an architect design pass) — the same effect is achieved with
  two plain resolver functions and a few plain arrays; introduce the fuller abstraction only if a
  third deployment path (beyond low-code/ADK) actually materializes.
- **Why**: root-caused from a live migration (`KB-Grounding-Test-Agent`) that reported
  `verified=true` and an "attached — engine-wide visibility" fidelity note for its SharePoint source,
  but never actually answered from it — the agent had fallen back to ADK, and ADK never got that
  source's resource path. User's ask was explicit parity: whichever path a migrated agent lands on,
  it must be able to use whatever knowledge sources it had at the source, not just a subset.
- **Impact**: no `AgentIR` shape change, no new DB collections/persistence — the resolved data is
  recomputed per insert attempt, not cached (the real work underneath, e.g. `createDataStore`, is
  already idempotency-checked). `FidelityNote` text now branches by which path actually ran: low-code
  keeps the existing "partial — engine-wide" wording; ADK gets a new "mapped/partial — per-agent, not
  engine-wide" note, plus a new `capability:web-browsing` **lost** note when ADK's
  `VertexAiSearchTool` silently displaced `googleSearch` (pre-1.16 ADK can't combine them — this was
  already true for file/website grounding but previously unreported). **Known limitation, not fixed
  here**: an agent with an *already-cached* ADK deployment (`adkDeployments` repo) short-circuits
  before reaching the new grounding logic on re-run — its `groundingDataStores` won't pick up
  SharePoint/Dataverse sources just by re-running the migration; the cached deployment record (or the
  underlying Reasoning Engine) needs to be cleared first so a fresh `publishAgentToGallery` call runs.
  Also out of scope: `FederatedStructuredSearchSource` (search-assisted OneDrive/SharePoint copy-mode)
  still uses `migrateSharePointDriveItem`'s agentFiles mechanism, which ADK agents don't support —
  same bug family, different mechanism, not touched by this fix.

---

## 2026-08-04 — Dataverse-snapshot BigQuery path for large tables (auto-threshold, inline kept)

- **Decision**: `knowledgeDataStoreExecutor.ts`'s `migrateDataverseSnapshot` now routes between two
  executors by row count instead of always using Discovery Engine's inline `documents:import` (capped
  at 100 rows/request): tables at or under `config.BQ_SNAPSHOT_ROW_THRESHOLD` (default 200) keep the
  original, unchanged inline path (`runInlineSnapshot`); larger tables go through a new BigQuery
  staging path (`runBigQuerySnapshot`) — export rows with real typed columns (`services/dataverseTableSchema.ts`),
  load them into a per-project BigQuery table (`services/bigqueryUpload.ts`, same plain-REST
  convention as `gcsUpload.ts`), then a single `documents:import` with a `bigquerySource` instead of
  `inlineSource` (`geminiDataStore.ts`'s new `importStructuredFromBigQuery`). The exported function's
  name and signature are unchanged, so `orchestrator.ts`'s call site needed zero edits. Considered and
  **rejected**: removing the inline path entirely and always using BigQuery. Every customer project
  would need a net-new BigQuery dataset, an enabled `bigquery.googleapis.com` API, and two more IAM
  roles (`bigquery.dataEditor`, `bigquery.jobUser`) just for the SA to use it — real infrastructure
  and audit surface with zero benefit for a 20-row currency/status lookup table. Auto-selecting by row
  count gets the BigQuery win (no 100-row cap, typed columns) exactly where it's needed and nowhere
  else.
- **Why**: the user is building this as an enterprise-grade migration tool and, after live-testing
  both approaches against a real project end to end (BigQuery dataset → table → load job → Discovery
  Engine structured data store → confirmed searchable), decided BigQuery should be the path for scale.
  An architect design pass (this repo's own rule for engine/pipeline changes) recommended the
  auto-threshold shape over a full replacement for the IAM/API-footprint reason above.
- **Impact**: `DataverseSnapshotResult` gained additive-only optional fields (`viaBigQuery`,
  `bqDatasetId`, `bqTableId`, `schemaNotes`) — non-breaking for the one existing consumer.
  `orchestrator.ts` now pushes real `FidelityNote`s for the Dataverse-snapshot path (previously only
  logged, never reported): success (naming which path ran), lookup/choice/money flattening (relationship
  semantics lost — `dataverseTableSchema.ts`'s `buildBqSchema` derives the exact note per column, not
  boilerplate), and a graceful `needs-review` note (never a blocked migration) when the BigQuery
  API/IAM isn't available on the customer's project. **Two things flagged, not yet fully verified
  live**: (1) the BigQuery import uses `reconciliationMode: 'FULL'` (not inline's `INCREMENTAL`) paired
  with the load job's `WRITE_TRUNCATE` — semantically correct since every run fully re-snapshots the
  table, and would incidentally fix a pre-existing gap (a row deleted upstream in Dataverse never gets
  removed from the data store under `INCREMENTAL`), but deletion behavior itself was not live-verified,
  only insert/update — treat "also fixes stale-row deletion" as unconfirmed until checked. (2) whether
  a real Gemini Enterprise agent's chat actually surfaces answers from a structured/BigQuery-backed
  data store (as opposed to it just being indexed and searchable, which WAS live-confirmed) is still
  blocked on a separate, pre-existing bug: this codebase's `:assist` conversational-query request shape
  doesn't match the current live API (`agentId`/`agent`/`toolsSpec`/`agentsSpec` all rejected) — that's
  tracked as its own issue, not something this change attempts to fix.
- **Live-verified 2026-08-04** (post-build spike, `_diag_bq_snapshot_real_test.ts`, threshold forced to 0
  via shell env var to force-route a real 1-row `contacts` table through the new path — NOT via an
  in-file `process.env` assignment, which silently no-ops due to ES module import hoisting running
  `config.ts`'s parse before any in-file code executes): the full `runBigQuerySnapshot` path — real
  Dataverse row → typed BigQuery table (399 columns) → load job → structured data store → `documents:import`
  from BigQuery → indexed document — works end to end against the real test tenant. The indexed
  document's `structData` showed correctly populated twin columns with real formatted values (e.g.
  `statuscode: "1"` + `statuscode_label: "Active"`, `preferredappointmenttimecode_label: "Morning"`),
  confirming the annotation-based formatting layer works on real data, not just synthetic fixtures.
  **Two minor, non-blocking refinements this test surfaced, logged for follow-up, not fixed here**:
  (1) Dataverse's metadata returns separate "Virtual" companion attributes for every choice/lookup field
  (e.g. `owneridname` alongside the real `ownerid`) that duplicate what `buildBqSchema`'s own `_name`/`_label`
  twins already provide — currently caught by the fallback branch (JSON-stringified, "unrecognized type"
  note), which is correct but noisy; a future pass could detect and skip `AttributeType: 'Virtual'`
  attributes whose name matches an existing lookup/choice column's twin. (2) A full standard Contact
  table produces ~400 BigQuery columns (mostly internal Dataverse plumbing like `adx_identity_*`) —
  not wrong, but wide enough that a future column-relevance filter might be worth considering.
- **Retroactive note**: `migrateDataverseSnapshot` (both before and after this change) calls both
  Dataverse (`resolvePrimaryKey`, `exportTableRows`/`resolveTableAttributes`) and Gemini
  (`createDataStore`, `importStructured*`, `attachDataStoreToEngine`) from the INSERT phase, using a
  Dataverse token re-minted at INSERT time — a narrow, deliberate exception to
  `architecture-boundaries.md`'s "extraction never calls Gemini" rule for bulky/tabular knowledge
  *content*, which is resolved by reference at INSERT time rather than staged in Mongo (unlike the
  small, structural `AgentIR`, which genuinely is staged). This carve-out already existed before
  today's change; recording it here since it was never written down.

## 2026-08-04 — Clean up orphaned low-code agents on ADK fallback; optional edition-aware skip

- **Decision**: Two changes to the low-code→ADK fallback in `orchestrator.ts`. (1) `services/gemini.ts`
  gained `deleteAgent()`; whenever the ADK fallback ends up being the real, final agent for a source
  (both the freshly-deployed case and the cached-reuse case), the orchestrator now deletes the
  stuck-`PRIVATE` low-code agent that was actually created, instead of leaving it sitting at the
  destination forever. Best-effort — failure surfaces as a `needs-review` fidelity note
  (`adk-fallback-cleanup`), never blocks the migration. (2) `GeminiDestination` gained an optional
  `edition?: 'business' | 'standard' | 'plus'` field. When a destination is explicitly declared
  `standard` or `plus`, the orchestrator skips the low-code `createAgent()` call entirely and goes
  straight to the ADK path — on those editions low-code agents are ALREADY KNOWN to stay `PRIVATE`
  forever (see docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md), so attempting it first was guaranteed
  to spend a quota unit and create an agent only to immediately delete it. Left unset (the default),
  behavior is unchanged: try low-code first on every destination, exactly as before.
- **Why**: While running a real end-to-end migration through the actual product (not a spike) with
  the new ADK file-grounding feature, hit `429 Agent creation quota exceeded` on repeated runs.
  Investigation surfaced two related but distinct problems, both real: (a) low-code `createAgent()`
  and ADK's `registerAdkAgent()` POST to the SAME Discovery Engine `.../agents` endpoint and share
  the SAME quota — every fallback that happens because low-code succeeded-but-stuck-`PRIVATE` (the
  documented, expected case, not a failure) spends TWO quota units and leaves TWO agent resources
  for one source agent; (b) nothing in the codebase ever cleaned up the orphaned one. The user's own
  proposed fix — "always try ADK first, skip low-code" — was rejected as the wrong solution: ADK is
  a real, ongoing-billable Reasoning Engine deploy (2-5 min, per-agent compute cost) that most agents
  never need; forcing every migration through it to save a quota unit that's only wasted in the
  fallback case would regress cost and latency for the common case, and wouldn't even have helped
  the specific quota-exhaustion just hit (both attempts failed because the quota was ALREADY zero
  before either call — ordering can't fix an empty bucket). The two changes above fix the actual
  problems (duplication, and *avoidable* double-spend) without that regression.
- **Impact**: `edition` is opt-in and NOT auto-detected — no reliable API signal for a Gemini
  Enterprise project's edition was found (this is the same reason `needsAdkDeployment()`'s old
  edition check was removed, per the 2026-08-02 entry below). Whoever configures a `GeminiDestination`
  (currently only via `routes/destination.ts` / internal resolution, no web UI capture yet) must set
  it explicitly for the skip to activate — surfacing it as a real setup-flow question ("what Gemini
  edition is this project?") in the Connect/destination UI is a follow-up, not done here. The
  cleanup half (`deleteAgent`) is unconditional and active today regardless of `edition`. Not yet
  live-tested end to end (the project used for testing all week is Business edition, where the skip
  never activates) — the skip-logic branch is new code that type-checks and matches the existing
  `CreateOutcome` shape, but hasn't been exercised against a real Standard/Plus project.

## 2026-08-03 — ADK agents can ground on locally-uploaded files (live-verified), wired end to end

- **Decision**: ADK/Reasoning-Engine agents (`adkDeployer.ts`) previously reported every uploaded
  knowledge file as `status: 'lost'` — "ADK deployment path doesn't support agentFiles yet." That's
  still true (ADK agents have no `agentFiles` concept at all), but it no longer means the file is
  unrecoverable: it's now grounded via a Discovery Engine **"document" data store** (unstructured
  content, not the website-only PUBLIC_WEBSITE tier) + `VertexAiSearchTool`, the same mechanism
  already used for public-website grounding. `AdkSpec.vertexAiSearchDataStore` (single store) was
  generalized to `AdkSpec.groundingDataStores: string[]`, combining a website store and any number
  of file stores onto **one** `VertexAiSearchTool` — ADK pre-1.16 only allows this tool alone on an
  agent (no mixing with `google_search`), and Google's own `data_store_specs` parameter is exactly
  for combining multiple stores under one tool instance. New pieces: `services/gcsUpload.ts` (plain
  REST, no new npm dep — same convention as `secretManager.ts`), `knowledgeDataStoreExecutor.ts`'s
  `migrateFileToDocumentStore()` (upload → `createDataStore(kind:'document')` → `importDocumentsFromGcs`
  → `awaitImport`, mirroring the existing `migrateDataverseSnapshot` pattern), `adkDeployer.ts`'s
  `ensureReasoningEngineDiscoveryAccess()`, and a new collection `adkKnowledgeStores` (idempotency —
  one row per agent+file, reused on re-migration instead of re-uploading/re-indexing every run).
  `orchestrator.ts` now resolves file grounding stores BEFORE calling `publishAgentToGallery`
  (the tool must be baked in at deploy time, unlike low-code's patchable `agentFiles`), and reports
  each file as `mapped` (grounded, IAM confirmed), `partial` (grounded, but the IAM grant below
  couldn't be confirmed — may 403 at query time), or `lost` (download/import genuinely failed) —
  never silently degraded.
- **Why**: Live-verified this end to end on a real throwaway test agent before writing any of the
  above (see the session that produced this decision): `createDataStore(kind:'document')` and
  `importDocumentsFromGcs()` existed in this codebase already, written months ago, but had **zero
  callers anywhere** — untested against the real API. Ran them for real: GCS upload, data-store
  creation, import, and full indexing all succeeded on the first attempt. Deployed a real ADK
  Reasoning Engine agent with `VertexAiSearchTool` pointed at that store, queried it, and got a
  clean 403 (`discoveryengine.servingConfigs.search` denied) — a genuine gap this decision fixes,
  not a design flaw: the SA that creates the data store and the Google-managed service agent that
  actually *executes* a deployed Reasoning Engine at inference time
  (`service-{project}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`) are different identities, and
  the latter has no Discovery Engine access by default. After granting it `roles/discoveryengine.viewer`
  on the project and re-querying, the SAME agent correctly retrieved the exact planted marker from
  the uploaded file, with grounding metadata pointing at the real GCS source — full proof, not a
  plausible-sounding design. This also retroactively fixes the SAME latent gap in the pre-existing
  website-grounding ADK path, which never granted this IAM role either.
- **Impact**: **This is a materially more privileged permission than anything else this tool asks
  a customer for today.** `ensureReasoningEngineDiscoveryAccess()` calls
  `cloudresourcemanager.projects.{get,set}IamPolicy` — project-level IAM policy editing, not a
  scoped Discovery Engine role. The verification session's SA happened to have this on the test
  project; **there is no guarantee a real customer's Direct-IAM or DWD grant includes it.** The
  function fails gracefully (best-effort, never blocks deployment) and `orchestrator.ts` reports a
  `needs-review`/`partial` fidelity note when the grant can't be confirmed — but this needs a real
  decision before shipping to a customer: either (a) ask the customer's Google admin to grant this
  IAM role once during setup (same category of ask as the existing Direct IAM/DWD dance), or
  (b) find a narrower, resource-scoped alternative. **Follow-up same day: checked live — option
  (b) does not exist.** `POST {dataStore}:getIamPolicy` against a real data store returns `404
  Method not found` — Discovery Engine data stores have no resource-level IAM policy at all;
  access is controlled ONLY via project- (or folder-/org-) level Cloud IAM. So the choice is
  binary: a customer admin grants the project-level role manually (recommended default for
  enterprise customers — see docs/ADK-FILE-GROUNDING-PERMISSIONS.md), or CloudFuze's SA gets
  `resourcemanager.projects.setIamPolicy` to grant it automatically (not recommended as a default;
  a materially bigger ask than this product's normal access model). Also still un-verified: the
  multi-store `data_store_specs` combination path (website + file sources together) — only the
  single-store case was live-tested; an agent with both a website source and file sources hits
  code that type-checks and matches Google's documented parameter shape, but has not been run for
  real yet.

---

## 2026-08-03 — Stop folding compiled Topics into the migrated instruction text

- **Decision**: `mapper.ts`'s `mapAgent()` no longer appends the topic-compiler's "## Conversation
  guidance" / "## Conversation procedures" block onto `MappedAgent.instruction`. Topics are still
  fully extracted (`AgentIR.topics`, unchanged) and still compiled via `planTopicsMigration` +
  `topicsEmit.buildProceduresInstruction` (unchanged, still used for the report), but the compiled
  text is now surfaced only as a `topics` `FidelityNote` with `status: 'needs-review'` — never
  concatenated into the live agent's instruction field. `MappedAgent.instruction` is now exactly
  `AgentIR.instructions`, verbatim, nothing else folded in.
- **Why**: While comparing a source Copilot Studio agent ("C2MessageGeneratorAgent," a customer-
  simulation persona bot with strict "never act as a support agent" rules) against its migrated
  Gemini agent, the migrated instruction had an appended block compiled from the agent's own
  Topics (Sign in / Thank you / Greeting) containing generic assistant-style guidance ("Greet the
  user warmly," "ask a clarifying question," a scripted sign-in line) sitting in the same free-text
  field as — and in tension with — the strict persona rules above it. Confirmed via
  `agentIRCache` that the base instructions were carried over 100% verbatim and that this
  appended block's topic names matched the agent's own extracted `AgentIR.topics` exactly (so it
  wasn't fabricated), but mixing topic-derived guidance into the same instruction text as the
  author's own words is a tone-fidelity risk regardless of source — the two are different kinds of
  authored content and shouldn't share one field silently.
- **Impact**: Topics are no longer auto-woven into agent behavior at all in v1 — every custom topic
  now reports as `needs-review` (same bucket the "custom topic(s) captured but NOT added to the
  instruction" note already used for topics with no plan). This is a net fidelity-reporting change,
  not a data-loss one: nothing about `AgentIR` changed, and the compiled procedures text is still
  computed and available (just not injected). Next engineering step, not yet done: give topics a
  real, separate migration target (e.g. Gemini's own topic/procedure resources, once verified to
  exist for this agent type) instead of any instruction-text injection at all — this change removes
  the injection but does not yet build that replacement.

## 2026-08-03 — Persist per-tenant Entra credentials in GCP Secret Manager (for connector auto-provisioning)

- **Decision**: While wiring up the SharePoint native-connector migration path (`geminiConnector.ts` →
  orchestrator), extended the "never persist the customer's Entra `clientSecret`" rule with one
  addition: CloudFuze now MAY persist it, but only (a) in **GCP Secret Manager** under CloudFuze's
  own project — never Mongo, never plaintext, never the customer's project — and (b) scoped **per
  tenant**, not per site. Mongo (`entraAppCredentials` repo) stores only a `secretName` reference,
  never the value. First site under a new tenant still requires the admin to submit
  Client ID/Secret/Tenant ID once; every subsequent *new* site under that same tenant reuses the
  stored credential with zero further admin interaction.
- **Why**: Without this, "no persistence" meant every previously-unseen SharePoint site — even
  under an already-onboarded tenant — required the admin to re-enter the same Entra app's secret.
  That's real, avoidable friction for an enterprise customer with many sites across many agents.
  Scoping by tenant (not caching the raw secret anywhere in our own DB, not going further to
  "store it forever with no re-consent path") keeps the blast radius of a CloudFuze database
  breach unchanged — Secret Manager, not Mongo, is the thing an attacker would need to compromise,
  and that's GCP's own hardened, audited, IAM-scoped secret store (this project's existing
  documented pattern in `config.ts` for CloudFuze's own static secrets), not a bespoke encryption
  scheme we'd have to build and maintain ourselves.
- **Impact**: New service `services/secretManager.ts` (plain REST calls, no new npm dependency —
  reuses the existing `cloud-platform` SA scope) and new repo `db/repos/entraAppCredentials.ts`
  (`{appUserId, tenantId}`-unique, non-secret fields only). `routes/destination.ts`'s connector
  setup flow now checks this store before requiring credentials in the request body. Revocation/
  rotation UX (what happens when a customer rotates their Entra secret, or wants CloudFuze's
  stored copy deleted) is NOT yet designed — flag as a follow-up before this ships to a real
  customer, not an oversight to silently paper over.

---

## 2026-08-02 — Agent-publish problem: ADK confirmed as the only viable path; A2A and Dialogflow CX rejected
- **Decision**: For the "migrated agent stays PRIVATE forever on Standard/Plus, no publish button
  exists anywhere" gap (see [docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md](../../docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md)),
  evaluated four `agents.create` definition types against official Google docs + this repo's own
  live tenant tests. **Re-activating the already-built ADK/Reasoning-Engine path
  (`server/src/services/adkDeployer.ts`, currently gated off by `needsAdkDeployment` returning
  `false`) is the only viable production direction.** A2A (`a2aAgentDefinition`) and Dialogflow CX
  registration (`dialogflowAgentDefinition`) are both **rejected** as build targets.
- **Why**: ADK is the only path with a *live-proven* (not just documented) `state: ENABLED` +
  gallery-visible outcome, and Google's Vertex AI Agent Engine runs the compute — CloudFuze never
  becomes a hosting company. A2A's "Agent Card" is only a discovery pointer to an endpoint the
  developer must host and run themselves (Google's own docs name Cloud Run explicitly); adopting
  it would mean building an entire second agent-runtime product from scratch for no proven
  advantage over ADK, on a feature still marked Pre-GA/Preview, whose traffic bypasses Agent
  Gateway governance policies entirely (a real concern for the security-conscious enterprise
  admins who are CS_GE's actual buyers). Dialogflow CX registration never shows a `state` field in
  any official example response (unverified whether it's even gallery-visible), confirmed requires
  a *second*, unrelated Draft→Version→Environment publish step inside Dialogflow's own console, and
  this repo's own `_diag_dialogflow_spike.ts`/`_diag_dialogflow_user.ts` already hit a live 403 from
  org governance/VPC-SC trying to create a CX agent programmatically — a wall real enterprise
  customers are likely to also have. Both alternatives would additionally require a brand-new
  IR-to-target mapper; CX especially, since its flow/intent paradigm doesn't map cleanly onto
  Copilot Studio's generative topic model.
- **Impact**: Next engineering step is re-enabling ADK as an explicit, cost-disclosed customer
  opt-in (never automatic — real ongoing Reasoning Engine compute cost lands on the customer's
  project) rather than building A2A or Dialogflow CX support. While re-enabling, fix a related
  honesty gap: the ADK branch in `orchestrator.ts` (~line 742) unconditionally sets
  `deployed = true, shared = true`, unlike the low-code branch which correctly mirrors whether the
  source Copilot agent was actually published vs. a draft — needs the same check before shipping.
  Separately and at higher priority: `lowCodeAgentDefinition` (the current default create path) no
  longer appears anywhere in Google's live v1alpha discovery document — verify it still works
  against a real tenant before anything else, since that risk is independent of and bigger than
  the publish-visibility question.

## 2026-07-30 — Public-website knowledge-source handling removed entirely
- **Decision**: Removed all "public website" special-casing from knowledge migration:
  the classifier's website rule + `websiteOwnership()` heuristic in `knowledgeClassifier.ts`,
  the website-folding action in `knowledgePlanner.ts`, the `buildKnowledgeReferencesAppendix()`
  workaround and `unsupportedKnowledgeHandling` option in `mapper.ts`, and the
  `knowledgeHandling` field threaded through `types.ts` → `orchestrator.ts` →
  `routes/migrate.ts` → `web/src/api.ts` → `Migrate.tsx`. A public website knowledge source
  now falls through to the generic unrecognized-kind `manual-review` path — the URL reference
  is still preserved losslessly on `AgentIR` and surfaced in the report, but nothing is
  auto-created and nothing is written into the migrated agent's instructions.
- **Why**: Gemini Enterprise assistant apps can't attach a website data store at all (confirmed,
  see [docs/knowledge-sources-migration-playbook.md §4.1](../../docs/knowledge-sources-migration-playbook.md)),
  so the only thing the old "appendix" path did was paste raw URLs into the agent's instruction
  text — not real grounding, just text the model happens to see. The user judged that workaround
  not worth keeping.
- **Impact**: `OrganizationProfile` / `organizationProfile.ts` (Graph `verifiedDomains` + Google
  Workspace domain discovery) is now unused dead code — kept in place on request (not deleted)
  in case a future feature wants org-domain discovery; it still runs once per migration and logs
  its result in `orchestrator.ts`, at the cost of two now-pointless API calls per run. The
  low-level Gemini website-data-store executor (`createDataStore('website', ...)` +
  `addTargetSite` + `attachDataStoreToEngine` in `geminiDataStore.ts`) was left untouched but is
  now fully orphaned — nothing calls it except the standalone `_diag_website*.ts` spikes.

## 2026-07-28 — gstack command renames in the `.claude/` scaffold
- **Decision**: When generating `.claude/commands/`, the scaffold's `review.md` was created as
  **`team-review.md`** to avoid colliding with gstack's reserved `/review`. `deploy.md` was kept
  (not removed) because CS_GE has genuine project-specific deploy logic gstack's
  `/land-and-deploy` doesn't know (two build targets, its own Mongo instance on 27019,
  service-account/Secret-Manager setup, the ADK `server/scripts/adk_deploy.py` path).
- **Why**: gstack is installed globally; slash-command names must not collide, and generic
  workflows should defer to gstack while project-specific ones stay local.
- **Impact**: Use `/team-review` for the CS_GE checklist and gstack `/review` for general bugs.
  No pre-existing custom commands/skills existed in `.claude/` at scaffold time, so there were no
  *other* collisions to rename. `.claude/settings.local.json` already existed and was left as-is.

## (undated, from initial build) — DB-backed staging decouples extract from insert
- **Decision**: Migration runs in two phases with Mongo `stagedAgents` as the handoff, not a
  single streaming pass.
- **Why**: A failed Gemini insert run must be retryable without re-hitting Dataverse; staging
  makes the pipeline resumable and the phases independently scalable.
- **Impact**: Extraction code never calls Gemini and vice-versa; the boundary is enforced in
  [.claude/rules/architecture-boundaries.md](../rules/architecture-boundaries.md).

## (undated) — Native MongoDB driver, no ODM
- **Decision**: Use the `mongodb` driver directly with one repo per collection; no Mongoose/Prisma.
- **Why**: Full control over indexes/queries, matches the GEM_CO reference, keeps the layer thin.
- **Impact**: Repos live in `db/repos/`; collections/indexes ensured idempotently in `db/mongo.ts`.

## (undated) — Best-effort persistence
- **Decision**: Every persistence write is best-effort (`isDbConnected()` guard, never throws);
  the app boots and migrates even if Mongo is down (in-memory session fallback).
- **Why**: A DB outage must not block a customer migration.
- **Impact**: Never assume a write succeeded; never `await` a repo write as if it's authoritative.

## (undated) — Client-agnostic destination discovery
- **Decision**: The Gemini engine/app id is discovered from the connected project at runtime
  (`resolveDestination`), never hardcoded.
- **Why**: The tool must work against any customer's project unchanged.
- **Impact**: No engine id literals anywhere; a hardcoded id is a review blocker.

## (undated) — Read the REAL agent content (fidelity over filler)
- **Decision**: Extract the actual `GptComponentMetadata.instructions`, full topic set, and AI
  Builder prompts from Dataverse; synthesize a faithful Gemini instruction.
- **Why**: The Python POC discarded real instructions and regex-scraped generic filler — low
  fidelity. This rebuild's entire value is behavioral fidelity + honest reporting.
- **Impact**: `AgentIR` is lossless; lossy mappings must emit `FidelityNote`s.

## (undated) — CS_GE runs its own MongoDB instance (port 27019)
- **Decision**: Default `MONGO_HOST=mongodb://localhost:27019`, db `csge`.
- **Why**: Avoid collisions with sibling projects on the same machine (GEM_CO 27017, itsm 27018).
- **Impact**: Local/deploy setup must point at the CS_GE instance.
## 2026-08-07 — componenttype 9 carries TOOLS as well as topics (`AgentIR.agentTools`)
- **Decision**: Split Dataverse `componenttype 9` on the `kind:` in its body — `AdaptiveDialog`
  is a topic, `TaskDialog` is a TOOL — and add `AgentIR.agentTools: AgentToolIR[]` capturing
  kind (`connector` | `mcp-server` | `connected-agent` | `ai-builder` | `unknown`),
  `connectorId`, `operationId`, model display name/description and declared outputs.
- **Why**: `ComponentType.Topic = 9` and extraction treated every type-9 row as a topic, so
  "Jira - Get list of issues" was migrated as a conversational topic and counted as one
  ("Enterprise Migration Knowledge" reported 22 topics; 13 are real). The operations the agent
  actually invokes — `GetIssue_V2`, `ListIssues`, `ListIssues_Datacenter`, `ListResources`,
  `mcp_JiraIssueManagement` — were nowhere in the IR, so mapping could not migrate them and the
  report could not say they were lost. Knowing an agent "uses Jira" is not enough to rebuild it.
- **Impact**: `AgentIR` gained an optional additive field — no existing consumer breaks, and
  agents with no tools omit it. Topic counts DROP for agents that use connector actions; that is
  a correction, not a regression. Every tool now emits a `FidelityNote` (`mapped` when a live
  connector tool was wired, `lost` otherwise). Connector detection also stopped dropping
  connectors with no registry entry (`shared_hubspotcrmv2`, `shared_cdataconnectai` were
  invisible), matching what `thirdPartyConnectorScan` already did for flows.
