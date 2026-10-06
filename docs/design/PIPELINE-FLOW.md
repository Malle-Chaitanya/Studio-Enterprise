# CS_GE pipeline — end to end, with module and function names

The whole project: a customer connects both clouds, we read their Copilot Studio agents, and
a working Gemini Enterprise agent comes out the other side with an honest report of what
survived. Every symbol named here was checked to exist.

For the connector half in depth — how a connector name becomes a callable tool — see
[DYNAMIC-CONNECTORS-FLOW.md](DYNAMIC-CONNECTORS-FLOW.md). This document is the layer above it.

---

## The whole chain

```
 ┌─ CONNECT ──────────────────────────────────────────── routes/auth.ts ──────┐
 │  Microsoft admin  auth/microsoft.ts  buildAuthUrl() → exchangeCode()       │
 │                                      tenantIdFromToken()                   │
 │                                      clientCredsToken(tenant, resource)    │
 │                                        └─ app-only, for Dataverse          │
 │  Google admin     auth/google.ts     getGoogleAccessToken()                │
 │                                      getSaToken(impersonate?)              │
 │                                        └─ direct IAM first, DWD second     │
 └────────────────────────────────────────────────────────────────────────────┘
                                   │  session id only; tokens stay server-side
 ┌─ EXPLORE ──────────────────────────────────── routes/explore.ts ───────────┐
 │  dataverse.ts   inventory(url, token)        environments, bot counts      │
 │                 listBots(url, token)         GET /api/data/v9.2/bots       │
 │  destination.ts listProjects() listEngines() the Gemini side               │
 └────────────────────────────────────────────────────────────────────────────┘
                                   │  web: Connect → ChoosePair → SelectMap → SelectData
 ┌─ PLAN ────────────────────────────── routes/migrate.ts:75  POST /plan ─────┐
 │  scope.ts        resolveScope(...)           which agents are in range     │
 │  assess.ts       assessAgent(ir)             what will and will not move   │
 │                  buildKnowledgeAssessment(ir)                              │
 │  surfaceCredentialRequirements.ts            what creds the customer owes  │
 └────────────────────────────────────────────────────────────────────────────┘
                                   │
 ╔═ PHASE 1 — EXTRACT ══════════════════════ orchestrator.ts:1048 ════════════╗
 ║  mapPool(bots, …)                                                          ║
 ║    dataverse.ts  extractAgent(url, token, bot, …)          → AgentIR       ║
 ║        readAgentPermissions()  countBotComponents()                        ║
 ║        getAiPromptMap()        parseFlowDefinition() → FlowIR              ║
 ║    mapper.ts     mapAgent(ir, opts)                        → MappedAgent   ║
 ║        topicGraph.ts   → topicCompiler.ts  compileTopic()                  ║
 ║        knowledgeClassifier.ts  classifyKnowledgeSource()                   ║
 ║    db/repos/staged.ts  stageAgent(row)      ──→ Mongo, keyed by appUserId  ║
 ╚════════════════════════════════════════════════════════════════════════════╝
                                   │  the ONLY handoff. Decouples retry from re-read.
 ╔═ PHASE 2 — INSERT ═══════════════════════ orchestrator.ts:1420 ════════════╗
 ║  listStaged(…) → mapPool(staged, INSERT_CONCURRENCY = 3, …)                ║
 ║                                                                            ║
 ║  gemini.ts     resolveDestination(project, saToken)   never hardcoded      ║
 ║                                                                            ║
 ║  ┌── which engine? ──────────────────────────────────────────────┐         ║
 ║  │  adkDeployer.ts  needsAdkDeployment(dest, ir)                 │         ║
 ║  │    false → LOW-CODE   gemini.ts  createAgent(dest, tok, map)  │         ║
 ║  │    true  → ADK        buildAdkSpec(…) → deployReasoningEngine()│        ║
 ║  │                       → registerAdkAgent()  (state=ENABLED)    │        ║
 ║  └───────────────────────────────────────────────────────────────┘         ║
 ║                                                                            ║
 ║  knowledge   knowledgePlanner.ts  planKnowledgeMigration()                 ║
 ║                geminiDataStore.ts / knowledgeDataStoreExecutor.ts          ║
 ║                sharePointMigrator.ts  confluenceMigrator.ts                ║
 ║                geminiAgentFiles.ts  uploadAgentFile()  updateAgentFiles()  ║
 ║  topics      topicsEmit.ts  buildRootGuidance()  buildProceduresInstruction│
 ║  connectors  boundToolSpec.ts  buildBoundToolSpecs()  ──→ see the other doc║
 ║                connectorToolBuilder.ts  buildLiveConnectorSpecsDetailed()  ║
 ║                                                                            ║
 ║  publish     gemini.ts  publishAgent()   (ADK path skips — already ENABLED)║
 ║  share       gemini.ts  shareAgent()  grantAgentAccess()  checkUserLicense()║
 ║  verify      verify.ts  verifyAgent()  classifyEvidence()                  ║
 ╚════════════════════════════════════════════════════════════════════════════╝
                                   │
 ┌─ REPORT ───────────────────────────────────────────────────────────────────┐
 │  report.ts  renderReportExcel(orgName, results)                            │
 │  FidelityNote[] collected all the way through — lost / needs-review        │
 └────────────────────────────────────────────────────────────────────────────┘

 progress throughout:  EventQueue → GET /api/migrate/stream (SSE)
                       ProgressEvent = log | progress | agent | done
```

---

## The six things that shape every decision here

**1. The IR is the contract.** `AgentIR` in `server/src/types.ts` is platform-neutral.
Extraction produces it; mapping consumes it; neither reaches across. Extraction code never
calls Gemini, and Gemini code never calls Dataverse. Changing its shape is an architectural
decision requiring a note in `.claude/memory/decisions.md`.

**2. Staging is the only handoff.** `stageAgent()` writing to Mongo is what makes a failed
insert run retryable without re-extracting. Short-circuiting it — writing Gemini agents
directly from extraction — would collapse the two phases into one long-running operation with
no retry point.

**3. Two auth paths, deliberately not interchangeable.** Microsoft extraction uses app-only
`clientCredsToken()` (delegated Dynamics consent triggers `AADSTS65001`). Google uses the
service account: direct IAM first, domain-wide delegation second. `getSaToken(impersonate?)`
is where a Google call becomes per-person.

**4. Persistence is best-effort.** Every repo write checks `isDbConnected()` and returns
quietly. The pipeline runs with Mongo down, on an in-memory session fallback. That is why a
dev machine with Docker stopped can still migrate.

**5. Multi-tenant by key, not by trust.** Every migration-scoped collection filters by
`appUserId`, derived from the authenticated session and never taken from the client.

**6. Honesty is a pipeline output, not a UI nicety.** `FidelityNote`s are produced at every
stage that loses something — a refused operation, an unmappable Power Fx expression, a
knowledge source that needs a human. `verifyAgent()` smoke-tests the deployed agent and
`classifyEvidence()` decides what the evidence actually supports. Overclaiming a successful
migration is treated as a trust failure, not a cosmetic one.

---

## Where the two engines diverge

`needsAdkDeployment()` is the fork that matters most, because the two paths have different
capabilities and different failure modes.

| | low-code (`createAgent`) | ADK (`deployReasoningEngine`) |
|---|---|---|
| what it is | a Discovery Engine agent built from the mapped IR | a Python Reasoning Engine we package and deploy |
| tools | Gemini-native | `scripts/adk_deploy.py` + `connector_tools/` |
| publish | `publishAgent()` — admin step | skipped; `registerAdkAgent()` returns `ENABLED` |
| connectors | limited | the full bound-operation path |

Anything needing live connector tools takes the ADK path. That is why the connector work in
the companion document is ADK-side.

---

## Request shapes, so new work matches

- **Routes** — one `Router` per domain in `src/routes/`, named export, mounted at
  `/api/<domain>`. Success is `res.json(<object>)`, a plain object, never an envelope. Errors
  are `res.status(n).json({ error: '<snake_case_code>', detail? })` and the client switches on
  `error`. Guards use the early-return `void` form.
- **Sessions** — the client holds an opaque id and nothing else. Tokens, plan and inventory
  live in `migrationSessions` with a TTL.
- **Streaming** — SSE, not polling. New event kinds go in the `ProgressEvent` union in
  `types.ts`; never an ad-hoc shape.
- **Fan-out** — `mapPool` with a bound. Never an unbounded `Promise.all` at Dataverse or
  Discovery Engine; Gemini writes back off on 429/503.
- **Layering** — routes → orchestrator → services → repos → db. Dependencies point down.
  Routes never touch Mongo directly; services never see `req`/`res`.

---

## Where the real risk sits today

Ordered by what would bite first, each grounded in a measurement rather than a worry.

| area | state |
|---|---|
| **connector dispatch** | 12 `if kind ==` branches early-return a fixed tool list; only `generic_rest.py` reads `boundOperations`. Six of the twelve are redundant. See the companion doc. |
| **`distil()` discards** | 385 of 1,134 captured operations have an untyped body; 0 of 4,174 parameters carry a description. Everything downstream is starved. |
| **cross-vendor verified** | 25 of 71 equivalence rows have had a real call made. `verified` is the honesty gate and most rows are honestly `false`. |
| **MCP** | `serverUrl` absent on 10/10 real bindings, so every MCP tool fails at deploy with "neither registryServerName nor serverUrl". 4 of 5 servers found are Microsoft-hosted and likely unreachable from a Google-deployed agent. |
| **vendor base URL** | not present in any Power Platform field. Needs a resolver with a liveness check — `shared_googlecontacts` points at an API Google retired in 2022 and passes every automated check. |

---

## Reading order for someone new

1. `server/src/types.ts` — `AgentIR` and the pipeline types. Start here; everything refers to it.
2. `server/src/orchestrator.ts` — the two phases, lines 1048 and 1420.
3. `.claude/memory/architecture.md` — DB schema, SSE, auth flows.
4. This document, then [DYNAMIC-CONNECTORS-FLOW.md](DYNAMIC-CONNECTORS-FLOW.md).
5. `docs/verification-ledger.md` — what has actually been proven live, and what has not. It is
   the difference between "we built it" and "we watched it work".
