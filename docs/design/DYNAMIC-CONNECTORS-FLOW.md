# Dynamic connectors — technical flow

How a connector goes from "a name on a Copilot agent" to "a working tool on a deployed Gemini
agent", with no per-connector Python. Every module and function named here is real; items
marked **TO BUILD** do not exist yet and are the work.

Measured against the live catalogue on 2026-10-06: **1,313 connectors offered, 1,306 captured.**

---

## The whole chain, GET to deploy

```
  POST /api/migrate/plan ─────────────────────────── routes/migrate.ts:75
         │
  ┌──────▼──────────────── PHASE 1 — EXTRACT ──────── orchestrator.ts:1048 ───┐
  │  GET {orgUrl}/api/data/v9.2/bots                                          │
  │    dataverse.ts  listBots()  ──→ extractAgent()  ──→ AgentIR              │
  │    mapper.ts     mapAgent()  ──→ MappedAgent                              │
  │    staged.ts        stageAgent()  ──→ Mongo (the handoff; retry point)    │
  └──────┬────────────────────────────────────────────────────────────────────┘
         │   a connector tool here is only:  shared_googledrive + "ListFolder"
  ┌──────▼──────────────── PHASE 2 — INSERT ───────── orchestrator.ts:1420 ───┐
  │                                                                           │
  │  §2 captureOpIndex.ts   resolveOpIndex()      name → the connector's       │
  │                           distil() | distilOriginalSwagger()   swagger     │
  │                                      │                                     │
  │  §3 operationBinding.ts bindOperation()       swagger → a real vendor URL  │
  │        VENDOR_BINDINGS  ├─ 'bindable'      ───────────────┐                │
  │                         ├─ 'proxy-only'    ──→ §6 resolver│ (3% of         │
  │                         ├─ 'custom-tool'                  │  connectors)   │
  │                         └─ 'unknown-*'     ──→ FidelityNote                │
  │                                      │                    │                │
  │  §4 boundToolSpec.ts    buildBoundToolSpecs() ←───────────┘                │
  │                           → BoundToolSpec[]   ← THE GENERIC TEMPLATE       │
  │                           → FidelityNote[]                                 │
  │                                      │                                     │
  │  §5 connectorToolBuilder.ts  buildLiveConnectorSpecsDetailed()             │
  │     orchestrator.ts:2385     { ...spec, boundOperations: bound }           │
  │     adkDeployer.ts           buildAdkSpec() → deployReasoningEngine()      │
  │                                      │                                     │
  │     adk_deploy.py  _build_live_connector_tool(conn, project)               │
  │                      _mint_token()   ← DWD subject, keyed on registry data │
  │                      ├─ 12x  if kind == …   (early return, fixed list)     │
  │                      └─ generic_rest.py  build_tools() → _make_bound_tool()│
  └───────────────────────────────────────────────────────────────────────────┘
         │
  verify.ts → report.ts → SSE 'done'
```

Read it as: **§2 turns a name into a definition, §3 turns a definition into a URL, §4 turns a
URL into a deployable row, §5 turns a row into a live Python callable.** Everything that is
"dynamic" lives in that four-step middle; §6 is the escape hatch for the 3% where §3 cannot
produce a URL.

---

## 0. The three classes a connector can be in

The whole design turns on one fact: strip `/{connectionId}` off a captured path, and what is
left either is the vendor's real path or it is not.

| class | what it means | count | path through this flow |
|---|---|---|---|
| **vendor-path** | the proxy is a pass-through; the path IS the vendor's | 1,220 (93%) | fully generic — one data fact, no code |
| **proxy-only** | Microsoft's `datasets`/`tables` abstraction, no vendor path underneath | 39 (3%) | needs a vendor catalogue + name→method translation |
| **uncertain** | neither pattern is clear | 47 (4%) | human look |

The 93% is an **upper bound, not an estimate**. The classifier agrees with 8 of 9
hand-verified verdicts in `VENDOR_BINDINGS` and the one it gets wrong (`shared_office365`) it
calls *easy when it is hard*. Two further caveats, both measured:

- `vendor-path` is a verdict about the **connector**, never about every operation on it.
  Google Tasks is vendor-path and five of its ten operations are polling triggers with no
  vendor route at all.
- A path can be vendor-shaped and **dead**. `shared_googlecontacts` scores 0% proxy and its
  paths are `/m8/feeds/contacts/default/full` — the GData API Google shut down in 2022. It
  passes every automated check and would produce a tool that fails against a retired endpoint.

---

## 1. EXTRACT — from the GET to a staged row

```
web/src/pages/Migrate.tsx
    └─ POST /api/migrate/plan          server/src/routes/migrate.ts:75
       GET  /api/migrate/stream        server/src/routes/migrate.ts:155   (SSE, EventQueue)

server/src/orchestrator.ts:1048        ── PHASE 1 — EXTRACT ──
    mapPool(bots, EXTRACT_CONCURRENCY, …)

  server/src/services/dataverse.ts
      listBots(url, token)                    → BotSummary[]
          GET {orgUrl}/api/data/v9.2/bots?$select=configuration,description
      extractAgent(url, token, bot, …)        → AgentIR
          GET …/botcomponents?$filter=_parentbotid_value eq {id}
          topics, knowledge sources, tools, settings, permissions
          readAgentPermissions(…)   countBotComponents(…)   getAiPromptMap(…)
          parseFlowDefinition(clientdata, …)  → FlowIR

  server/src/services/mapper.ts
      mapAgent(ir, opts)                      → MappedAgent

  server/src/db/repos/staged.ts
      stageAgent(row)                         → stagedAgents collection, keyed by appUserId
```

Two things matter for everything below.

**The IR is the boundary.** `AgentIR` in `server/src/types.ts` is platform-neutral: extraction
produces it, mapping consumes it, and neither side reaches across. Extraction never calls
Gemini.

**What a connector tool actually gives us is a NAME.** Inside `AgentIR.agentTools`, a Copilot
connector tool carries a connector id (`shared_googledrive`), an operation id (`ListFolder`),
and the arguments the author pinned — and that is all. The operation's verb, path, parameters
and description are **not stored on the agent**; `captureOpIndex.ts` says so outright, because
recreating the tools without the swagger's text "produces four tools the model cannot tell
apart". Turning that name into a callable request is the entire job of §2–§5.

Staging in Mongo is what decouples the phases: a failed insert run is retryable without
re-extracting.

```
server/src/orchestrator.ts:1420        ── PHASE 2 — INSERT ──
    listStaged(…) → mapPool(staged, INSERT_CONCURRENCY=3, …) → §2 onward
    markStaged(…) on completion
```

---

## 2. CAPTURE — the connector's own definition

```
server/src/connectors/captureOpIndex.ts
    resolveOpIndex(connectorId, ctx)        → ConnectorOpIndex | undefined
    ├─ getCachedOpIndex(...)                 1. this customer's capture, ≤14 days
    ├─ captureOpIndex(connectorId, ctx)      2. live from THEIR environment
    │    └─ distil(connectorId, body)           proxy swagger → index
    ├─ captureCustomConnector(connectorId)   3. admin scope, for custom connectors
    │    └─ distilOriginalSwagger(...)          vendor swagger → index + vendorBinding
    ├─ loadFromRegistry(connectorId)         4. db/repos/connectorRegistry.ts
    └─ loadOpIndex(connectorId)              5. committed fixture
```

`distilOriginalSwagger()` already derives a `vendorBinding` — base URL, path style and
credential shape — straight from a custom connector's published definition. That is the
no-code path working today, for the one case where the vendor's own swagger is reachable.

**Gap — `distil()` discards what a generic tool needs.** Measured across 1,134 fixture
operations: **385 (34%) have an untyped body**, and `OpIndexParameter` has no `description`
field at all, so **0 of 4,174 parameters carry one**. The swagger holds `description`, `enum`,
`default`, `x-ms-summary` and `definitions.$ref`; the index keeps `name`, `in`, `required`,
`type`, `visibility`. There is also an asymmetry: `distilOriginalSwagger()` takes
`description || summary`, `distil()` takes `summary` only.

> **TO BUILD — `distil()` widening.** Add `description`, `enum`, `default` to
> `OpIndexParameter`; resolve `schema.$ref` against `swagger.definitions` into a typed body.
> Zero behaviour change, and every stage below is starved without it.

---

## 3. BIND — name + definition → a real vendor call

```
server/src/connectors/operationBinding.ts
    VENDOR_BINDINGS                          hand-typed table, 15 entries
    bindOperation(index, operationId)        → BindingResult
        'bindable' | 'unknown-connector' | 'unknown-operation'
        | 'proxy-only' | 'custom-tool'
```

`bindOperation` prefers `index.vendorBinding` (derived at capture) over `VENDOR_BINDINGS`
(hand-typed), strips `{connectionId}`, refuses `/trigger<n>/` paths per operation, drops
`x-ms-visibility: internal` parameters, and reports unresolved `{placeholders}` as
`contextRequired`.

**The one fact it still needs by hand: `baseUrl`.** It is not in Power Platform's data
anywhere — verified on `shared_jira`, `shared_googlecalendar`, `shared_zendesk`: every field
(`runtimeUrls`, `primaryRuntimeUrl`, `swagger.host`) is the apihub proxy, and there is no
`backendService`. Deriving it from `connectionAuth.resource` works for 2 of 9 and is
**silently wrong** for a third (Dataverse derives `disco.crm.dynamics.com`, not the org URL).

> **TO BUILD — `resolveVendorBaseUrl(index)`**, a chain ending in refusal:
> `index.vendorBinding` → `VENDOR_BINDINGS` → vendor spec lookup → **refuse by name**.
> Must include a **liveness check**: one read-only request per connector. Without it,
> `shared_googlecontacts` ships a tool pointed at an API Google retired.

---

## 4. SPEC — one deployable row per operation

```
server/src/connectors/boundToolSpec.ts
    buildBoundToolSpecs(ir, ctx, contextValues)   → { byConnector, notes }
        BoundToolSpec { toolName, connectorId, operationId, method, urlTemplate,
                        description, fixedArgs, modelArgs, contextRequired,
                        contextValues, auth, aadResource }
```

**`BoundToolSpec` is the generic template.** It already exists and already works — Dataverse
runs on it in production. Anything that can be expressed as one of these rows needs no Python.

Refusals become `FidelityNote`s here, never silence. A pinned Power Fx expression is dropped
and reported `needs-review`; if it was required, the operation is refused outright.

---

## 5. DEPLOY — rows → live tools

```
server/src/services/connectorToolBuilder.ts
    agentConnectorIds(ir)
    resolveConnectorSecrets(...)
    buildLiveConnectorSpecsDetailed(...)         → LiveConnectorSpec[]

server/src/orchestrator.ts:2385
    { ...withOps, boundOperations: bound }       specs attached to the connector

server/src/services/adkDeployer.ts
    buildAdkSpec(...)   → AdkSpec
    deployReasoningEngine(...)

server/scripts/adk_deploy.py
    _build_live_connector_tool(conn, project)
        _mint_token(...)      ← google-service-account branch applies the DWD subject
        _caller_var()         ← module-level; who is asking
        ├─ if kind == "googledrive" / "gmail" / ... (12 branches, early return)
        └─ connector_tools/generic_rest.py
               build_tools(conn, secret, mint_token, auth_header, fill, caller)
                   _make_bound_tool(op)   → one typed callable per bound operation
```

**The dispatch is the blocker for existing connectors.** Twelve `if kind ==` branches
early-return a *fixed* tool list. Only `generic_rest.py` reads `conn["boundOperations"]`, so a
connector with a dedicated module ignores what the source agent actually bound. Six of those
twelve (`jira`, `confluence`, `hubspotcrm`, `hubspotcrmv2`, `hubspotsettingsv2`, `teams`)
already have working vendor-path bindings and predate the bound-operation path.

Note what is **not** a blocker: auth. `_mint_token` keys on `conn.impersonationResolve`, never
on kind, so any Google connector gets per-caller DWD and fail-closed behaviour for free.

> **TO BUILD — per-operation dispatch.** Replace the per-connector fork with an override
> table keyed by `(kind, method)`, falling through to the generic builder:
> ```python
> GOOGLE_OVERRIDES = {
>     ("googledrive", "files.create"): google_drive.create_file,   # supportsMediaUpload
>     ("gmail", "users.messages.send"): gmail.send_message,        # RFC 2822 + base64url
> }
> ```
> Shadow-diff before wiring: build generated tools alongside the live ones, compare
> declarations, deploy nothing.

---

## 6. The proxy-only path (the 3%)

Only needed where step 3 returns `proxy-only`. Prototyped, not production.

```
src/spikes/_probe_name_to_api_call.py
    scope_index(index)              scope → every api declaring it (swept from Discovery)
    apis_for_scopes(scopes, index)  connectionAuth → the vendor APIs actually reachable
    surface_of(path)                Power Platform's own contract: tabular | file | schema
    score(op, method)               action, verb, noun, cardinality, params, description
    resolve(op, apis)               → match | ambiguous | refused

src/spikes/_probe_google_generic_builder.py
    build_tool(name, method, doc)   Discovery method → tool signature + blockers
```

**Measured on Google Drive, hand-audited: 11 of 23 operations correct, 3 confidently wrong,
4 ambiguous, 5 refused (3 of those correctly).** Roughly half automatic, and wrong about 1 in
8 — which is why this path must not auto-wire.

Two findings that shaped it, both worth not relearning:

- Guessing the API from the scope string verified and was still wrong. `auth/drive` is
  declared by **seven** APIs (drive, sheets, docs, slides, script, forms, workspaceevents), so
  every row/table operation got force-matched into Drive. Ask the catalogue, don't guess at it.
- A synonym table bridging Microsoft's words to the vendor's smuggles app knowledge back in,
  and fails upward. An `item → file` entry made `DeleteItem` ("Delete Row") resolve to
  `drive.files.delete` — deleting the whole spreadsheet instead of one row. Replaced by
  `surface_of()`, which reads Power Platform's own path vocabulary
  (`/datasets/{d}/tables/{t}/items/{i}` is Microsoft's tabular contract, shared by Excel, SQL
  and Dataverse — not a Google fact).

> **TO BUILD — the confirm store.** Resolution is **not per-customer**: Microsoft's connector
> definition and the vendor's API are the same for everyone. One confirm pass per connector,
> checked in, serves every customer forever (~9 rows for Drive). Refuse by default; only
> high-confidence rows auto-wire; every refusal becomes a `FidelityNote`.

---

## 7. Cross-vendor (Outlook → Gmail, Teams → Chat)

```
server/src/connectors/equivalence.ts
    EQUIVALENCES                             71 rows
    surfaceForConnector(connectorId)         → M365Surface | null
    findEquivalence(surface, operationId)    → matches operationId OR covers[]
    summarise(rows)                          → { exact, narrowed, lost, built, verified }

server/src/connectors/coverage.ts            SAME-VENDOR — a different table, do not mix
    findCoverage(connectorId, operationId)
```

**This cannot be generated and should not be.** Same-vendor rewrites a host and keeps the
semantics. Cross-vendor changes the vendor, so only the *intent* survives — an Outlook message
is not a Gmail message, a folder is not a label. Every row carries a fidelity verdict that is
**judged**, not derived, and `verified` means a real call was made.

Current state: 12 exact, 45 narrowed, 14 lost; **25 of 71 verified live**. By operation:
`shared_office365` 43/143 judged, `shared_teams` 32/170, `shared_sharepointonline` 3/141,
`shared_onedrive` 2/56 — **80 of 510 (16%)**.

16% is the wrong number to panic about. The table was built demand-first, and the ledger
measured the demand: *"the MS connector work is 1 operation, not 340"* — of 340 operations
across the three proxy-only Microsoft connectors, exactly one is called by any of 131 agents.

> **TO MEASURE — re-run `src/spikes/_diag_ms_op_usage.ts`** (needs Mongo) to turn 16% into a
> number against real demand, then fill only the gap it shows.
>
> **TO CHECK —** six Teams rows (`GetMessagesInChannel`, `ListChannels`,
> `ListRepliesOfChannelMessage`, …) name operations with no exact or near match in the
> captured Teams swagger, whose message operations are `ComposeAMessage`,
> `GetMessageDetails`. The type permits a capability label in `operationId`, so this may be
> intentional — but if those were meant to match operation ids, `findEquivalence` never fires
> and the agent gets no fidelity note.

---

## 8. Google, as a worked example

`server/src/connectors/googleCatalog.ts` is generated from Discovery by
`src/spikes/_gen_google_catalog.ts`; `server/src/connectors/google.ts` turns it into
`ConnectorDef`s with one shared policy block.

```
google.ts
    googleConnectors()           → ConnectorDef[]   (10 apps, one policy)
    googleAppsAwaitingScope()    → string[]         (catalogued, no scope decided)
```

Stating the policy once fixed a real bug: `shared_googlecalendar`, `shared_googlecontacts` and
`shared_googlechat` had been typed without an `impersonation` block, so every **invoker** agent
on those three failed closed. The runtime was always generic; only the hand-typed rows were
wrong.

`scope` is deliberately **not** generated. Three plausible derivations each produced a worse
grant than a human had chosen — "the scope most methods accept" gives Sheets, Docs, Slides and
Forms `auth/drive`, i.e. every file in the customer's Drive to use a spreadsheet. The rule that
does work lives in `src/spikes/_probe_google_scope_rule.py` → `propose(api, scope_index)`:
group by scope family, take the family the app **owns** rather than borrows, then the broadest
inside it. It reproduces all four single-scope human choices exactly, and it still **proposes** —
a scope grants real access, so a person agrees before it lands.

Where each Google connector goes:

| connector | class | path |
|---|---|---|
| `shared_googletasks` | vendor-path | **generic, zero Python** — binding only |
| `shared_gmail`, `googledrive`, `googlecalendar`, `googlecontacts`, `googlechat` | — | keep their modules; they encode behaviour Discovery cannot supply |
| `shared_googlesheet` | proxy-only 55% | needs §6 |
| `shared_googledocs`, `googleslides`, `googleforms` | — | no Power Platform source connector exists; destination-only, need §7 rows |

**Why the existing five keep their files.** `connector_tools/calendar.py`'s
`calendar_list_events` sets `singleEvents=true` ("expands recurring series into real
occurrences"), *requires* a time range because `events.list` without one returns the wrong
slice of a recurring series, clamps results to 1–25, and reports `mailbox` on every response.
None of that is in Discovery. An earlier measurement said 84% of the 51 hand-written tools were
reproducible — that measured **signatures**, which is the easy half.

> **The rule:** a connector gets a Python module when it needs *behaviour*, not when it needs
> *an API*. Tasks needed an API. Calendar needs behaviour.

---

## Build order

| # | work | risk | unblocks |
|---|---|---|---|
| 1 | `distil()` widening (§2) | none | everything downstream |
| 2 | `resolveVendorBaseUrl` + liveness (§3) | low | the 1,220 vendor-path connectors |
| 3 | confirm store (§6) | none deployed | makes 4 safe |
| 4 | per-operation dispatch (§5) | **medium** | removes the 12-branch fork |
| 5 | delete the 6 redundant modules (§5) | low | — |

Steps 1–3 deploy nothing. Step 4 is the only one that touches live dispatch, and it needs the
shadow diff first — 51 hand-written tools work in production today.

**What never generates:** media upload (`supportsMediaUpload` — Discovery names the protocol,
not the framing), MIME assembly (Gmail `raw`), and request-object APIs (Sheets deletes a row
via `batchUpdate` + `DeleteDimensionRequest`). About 3 of 51. These are reported as
limitations, not migrated badly.
