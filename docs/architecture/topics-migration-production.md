# Topics Migration — Production Architecture

**Scope:** The Topics module of the Copilot Studio → Gemini Enterprise migration platform.
Multi-tenant, commercial. This document is the build contract for the module.

---

## 1. Principles (non-negotiable)

1. **Lossless capture** — the source is stored verbatim before any transformation; every derived artifact is regenerable from the DB.
2. **Behavioral fidelity over structural mimicry** — we reproduce what a topic *does*, not its dialog tree.
3. **Honesty over overclaiming** — every unit carries a fidelity rating and named lossy items; nothing is silently dropped.
4. **Recommendations, not decisions** — grouping, granularity, and non-generative fallbacks are surfaced for client approval.
5. **Provenance everywhere** — every destination artifact traces back to source node IDs.
6. **Deterministic core, isolated LLM** — parsing/normalization are pure and reproducible; the LLM is confined to one guardrailed stage.

---

## 2. The domain model: three layers

| Layer | Unit | Vocabulary | Persisted as |
|---|---|---|---|
| Source | Topic / sub-dialog | Copilot internals (never leaks past PARSE) | Raw blob (GCS) + AST |
| **Canonical (IR)** | **Capability** | Business concept — the durable unit | Postgres (flat, queryable) |
| Destination | Connected Agent (domain group) + Workflow | Gemini Enterprise | Emitted artifacts + deploy records |

A **Capability** = a topic promoted to a business unit: `{name, domain, trigger_examples, steps[], tools[], knowledge[], state_in[], state_out[], verbatim_blocks[], fidelity, provenance}`. Capabilities group by **domain** into **connected agents**. Customers see capabilities and domains — never "Topic 47".

---

## 3. Tech stack (with rationale)

| Concern | Choice | Rationale |
|---|---|---|
| Language | **TypeScript / Node 20** | Matches team's existing JS; strong typing for a schema-heavy pipeline |
| Compute | **Cloud Run** (containers) | Destination is GCP; co-locate; scale-to-zero per tenant workload |
| Staging + Canonical store | **Cloud SQL for PostgreSQL** | **All metadata** in DB: `JSONB` staging (lossless, complete, queryable) + normalized IR; Row-Level Security for tenant isolation |
| Binary file store | **GCS** (versioned bucket) | Only large knowledge *files*; metadata pointers live in the DB |
| Async / work distribution | **Cloud Tasks** (per-capability jobs) + **Pub/Sub** (stage events) | Durable, per-item isolation, backpressure |
| Orchestration | **Code state-machine** persisted in Postgres | Resumable, testable; avoids vendor lock to a workflow DSL |
| Secrets | **Secret Manager** (per-tenant) | Dataverse creds never touch the DB |
| LLM | **Vertex AI (Gemini)** behind an adapter | Co-located; adapter keeps model swappable |
| Destination APIs | Gemini Enterprise Agents API, Cloud Workflows API — **behind an Emitter adapter** | These schemas drift; isolate + version-pin |
| Observability | Cloud Logging / Trace / Monitoring + OpenTelemetry | Per-stage metrics, tracing, audit |

---

## 4. Service decomposition (bounded contexts)

```
                          ┌─────────────────────────────────────────────┐
                          │              Control Plane (API)             │
                          │   REST: runs, status, review queue, reports  │
                          └───────────────┬─────────────────────────────┘
                                          │ enqueues
                 ┌────────────────────────┼────────────────────────┐
                 ▼                        ▼                        ▼
        ┌──────────────┐        ┌──────────────────┐      ┌────────────────┐
        │  Ingestion   │        │  Migration Worker │      │   Deployer     │
        │  (Dataverse/ │        │  (pipeline stages │      │ (Gemini + CWF  │
        │   ZIP pull)  │        │   1..6 per item)  │      │  emit/deploy)  │
        └──────┬───────┘        └────────┬─────────┘      └───────┬────────┘
               │  raw blob               │  IR / artifacts        │ deploy records
               ▼                         ▼                        ▼
        ┌──────────┐            ┌───────────────────┐     ┌────────────────┐
        │   GCS    │            │  PostgreSQL (IR)  │     │  PostgreSQL    │
        │ (lossless│            │  + RLS per tenant │     │  (deploy log)  │
        └──────────┘            └───────────────────┘     └────────────────┘

  Separate deployment — the migrated runtime (NOT the migration pipeline):
        User → Root Agent → Connected Agent → Capability → Cloud Workflow → Response
```

Each context is independently deployable. Workers are stateless; all state lives in Postgres/GCS so any worker can resume any item.

---

## 5. Pipeline & state machine (resumable)

This is **ELT + deliver**: **E**xtract → **L**oad-to-DB (staging, lossless) → **T**ransform (normalize + synthesize) → **Deliver** (deploy). The stages below map to that: INGEST=Extract, PARSE+NORMALIZE=Load-to-staging, ANALYZE..VALIDATE=Transform, EMIT/DEPLOY=Deliver.

Seven stages, each a checkpoint. A `migration_item` (one per source component) advances through states; failure isolates to the item and dead-letters without blocking siblings.

**Completeness guarantee (capture 100%, map incrementally):** INGEST loads the *entire* source payload of *every* component type — agent metadata, instructions, knowledge refs, actions, entities, variables, topics, channels, auth references, settings, connected agents — into the `staging_*` tables as lossless `JSONB`, **including fields the tool does not yet map**. Normalization is a projection over staging; a currently-unmapped field is never lost, only not-yet-transformed.

```
INGESTED → PARSED → NORMALIZED → ANALYZED → GROUPED → SYNTHESIZED → VALIDATED → EMITTED → DEPLOYED
                                                                          │
                                                                  (needs_review) → HELD → (approve) → EMITTED
   any stage → FAILED (dead-letter, retryable)
```

- **Idempotency:** each stage keyed by `(item_id, stage, source_hash)`. Re-running an unchanged item is a no-op (returns cached output). Re-migration after a source change re-runs only from the first changed stage.
- **Resumability:** a crashed run resumes from the last committed checkpoint; no stage repeats side effects (deploys guarded by an idempotency key sent to Google APIs).
- **Concurrency:** Cloud Tasks dispatches items to a bounded worker pool; per-tenant rate limits protect Dataverse, Vertex AI, and Google deploy APIs.

Stage responsibilities:

| Stage | Pure? | Output |
|---|---|---|
| 1 PARSE | ✅ | AST (+ `UnknownNode` capture, never fails) |
| 2 NORMALIZE | ✅ | Canonical Capability rows (lossless raw linked) |
| 3 ANALYZE | mostly (LLM optional) | classification, capability derivation, domain tag, redirect graph |
| 4 GROUP | ✅ | connected-agent plan (granularity knob) |
| 5 SYNTHESIZE | **LLM-assisted, guardrailed** | instructions, tool defs, workflow specs |
| 6 VALIDATE | ✅ | fidelity score, state-threading check, verbatim audit |
| 7 EMIT/DEPLOY | ✅ (adapter) | Gemini agents + Cloud Workflows + mapping report |

---

## 6. Data model (PostgreSQL, RLS on `tenant_id`)

```sql
-- STAGING (raw, lossless, complete — every component type, every field, even unmapped)
CREATE TABLE staging_components (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
  agent_id UUID, component_type TEXT,             -- agent|topic|action|entity|variable|knowledge|channel|setting|...
  external_id TEXT,                               -- Dataverse row id
  raw JSONB NOT NULL,                             -- the COMPLETE source payload, verbatim
  source_hash TEXT NOT NULL,                      -- idempotency / change-detection key
  file_gcs_uri TEXT,                              -- set only for binary knowledge files
  loaded_at TIMESTAMPTZ,
  UNIQUE (tenant_id, external_id, source_hash));  -- hash-keyed upsert = parallel-safe

-- Source (normalized projections over staging)
CREATE TABLE source_agents (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
  name TEXT, orchestration_mode TEXT,           -- classic | generative
  raw_gcs_uri TEXT, source_hash TEXT, created_at TIMESTAMPTZ);

CREATE TABLE source_topics (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL, agent_id UUID REFERENCES source_agents,
  name TEXT, raw_gcs_uri TEXT, source_hash TEXT,
  ast JSONB);                                     -- parsed tree, lossless

-- Canonical (the IR — flat, queryable)
CREATE TABLE capabilities (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL, topic_id UUID REFERENCES source_topics,
  name TEXT, domain TEXT,
  classification TEXT,                            -- system|qa|transactional|orchestration
  fidelity TEXT,                                  -- direct|partial|manual
  confidence NUMERIC, needs_human_review BOOLEAN,
  connected_agent_id UUID);                        -- assigned in GROUP

CREATE TABLE capability_triggers   (capability_id UUID, phrase TEXT);
CREATE TABLE capability_steps      (capability_id UUID, seq INT, kind TEXT,
                                    text TEXT, condition_expr TEXT, tool_ref TEXT,
                                    source_node_ids TEXT[]);           -- provenance
CREATE TABLE capability_state      (capability_id UUID, var_name TEXT,
                                    direction TEXT, resolved_param TEXT); -- state threading
CREATE TABLE capability_verbatim   (capability_id UUID, node_id TEXT, text TEXT); -- locked
CREATE TABLE capability_tools      (capability_id UUID, tool_id UUID);  -- FK → Actions module
CREATE TABLE capability_edges      (from_capability_id UUID, to_capability_id UUID, edge_type TEXT);

-- Destination plan + output
CREATE TABLE connected_agents (
  id UUID PRIMARY KEY, tenant_id UUID, root_agent_id UUID,
  display_name TEXT, domain TEXT, granularity TEXT);

CREATE TABLE emitted_artifacts (
  id UUID PRIMARY KEY, tenant_id UUID, capability_id UUID,
  kind TEXT,                                      -- instruction|tool|workflow|agent
  payload JSONB, source_node_ids TEXT[]);         -- provenance both directions

CREATE TABLE deploy_log (
  id UUID PRIMARY KEY, tenant_id UUID, artifact_id UUID,
  target_ref TEXT, idempotency_key TEXT, status TEXT, deployed_at TIMESTAMPTZ);

CREATE TABLE mapping_report (
  capability_id UUID PRIMARY KEY, tenant_id UUID,
  disposition TEXT, grouped_because TEXT,
  lossy_items TEXT[], manual_actions TEXT[]);

-- Orchestration
CREATE TABLE migration_items (
  id UUID PRIMARY KEY, tenant_id UUID, topic_id UUID,
  stage TEXT, status TEXT, source_hash TEXT,
  attempts INT, last_error TEXT, updated_at TIMESTAMPTZ);
```

Provenance is bidirectional: `capability_steps.source_node_ids` (source→IR) and `emitted_artifacts.source_node_ids` (IR→destination).

---

## 7. The synthesis engine (stage 5 — the hard core)

Code owns structure; the LLM owns only prose. The contract:

**Inputs to the LLM:** the structured Capability IR — **never raw YAML**.
**Guardrails:**
- Output must be **valid JSON against a fixed schema** (retry on violation).
- Every generated instruction cites the `source_node_ids` it covers.
- `capability_verbatim` blocks are injected **verbatim** and marked immutable — the model may not paraphrase.
- State references (`Topic.x`) are pre-resolved by code into real inputs via `capability_state.resolved_param` before the prompt is built (variable read/write graph analysis). The LLM never sees dead references.
- Deterministic/compliance capabilities (`classification=…` + strict ordering) are down-rated to `fidelity=partial|manual` and flagged — the synthesizer does not pretend a generative agent enforces the branch.

**Strategy per classification:**

| Classification | Output |
|---|---|
| system | Root-agent config (greeting/fallback/escalation) — templated, no LLM |
| qa | Instruction block (+ grounding) |
| transactional | Tool def (schema from Actions module) + collection instructions + Cloud Workflow |
| orchestration | Routing instructions; dense clusters → connected sub-agent |

**Model governance:** prompt templates are versioned; each synthesis records `(prompt_version, model, tokens, cost)` for audit and reproducibility.

---

## 8. State threading (what pure templating misses)

Before synthesis, a code pass builds the variable dependency graph per capability:
- For each `SetVariable`/`Question` → mark `direction=write`.
- For each reference in a later node → mark `direction=read`, resolve to the writing step.
- Emit `resolved_param`: `Topic.dealId` → tool parameter `dealId`; cross-capability reads → connected-agent shared state.
- Unresolvable reads (no writer) → flagged lossy item, not silently emitted.

This is deterministic graph analysis, unit-tested against fixtures.

---

## 9. Multi-tenancy & security

- **Isolation:** `tenant_id` on every row; Postgres **RLS** enforces it at the DB layer, not app trust. Separate GCS prefixes per tenant.
- **Secrets:** Dataverse OAuth creds live only in Secret Manager, keyed per tenant; **never** copied into the DB or into emitted artifacts. Destination auth is a `manual_action` the client completes.
- **Least privilege:** workers get scoped service accounts (read Dataverse, write GCS/SQL, deploy to the tenant's Google project only).
- **Audit:** every state transition, LLM call, and deploy is appended to an immutable audit log.

---

## 10. Reliability

- **Partial-failure isolation:** one capability failing dead-letters that item; the run continues.
- **Retries:** exponential backoff on transient Dataverse/Vertex/Google errors; poison items → DLQ with `last_error`.
- **Idempotent deploys:** Google API calls carry an idempotency key derived from `(artifact_id, payload_hash)`; re-deploy is safe.
- **Dry-run mode:** EMIT can produce artifacts without deploying (client review before anything hits their Google project).

---

## 11. Observability

- Per-stage latency, success/failure counts, LLM token/cost per capability, fidelity distribution per run.
- Distributed trace spans one item across all seven stages.
- A **run dashboard**: N topics → X direct / Y partial / Z manual, K needs-review, cost, ETA.

---

## 11a. Parallelism & performance

Migration is **ELT + deliver**, parallelized two ways. A single item obeys the dependency order (you can't transform before you extract); throughput comes from overlap and fan-out, not from breaking that order.

**a) Pipelining (stages overlap).** While component #500 still extracts, #1 already transforms and #50 deploys. Wall-clock ≈ the slowest single-item chain, not the sum of stages. Implemented by making each stage emit a Pub/Sub event that enqueues the next — no phase barriers.

**b) Partitioned concurrency.** Partition `tenant → agent → component`; each component is an independent worker unit from a bounded pool (Cloud Tasks). 490 components / 30 agents = a wide fan-out.

**The one real barrier (stated honestly):** domain **GROUP** needs *all* capabilities of an agent before clustering. It is a genuine per-agent synchronization point — isolated, not denied: agent A groups while agent B is still extracting. Everything else pipelines freely.

**Performance techniques:**
- **Bulk load** — Postgres `COPY` / batched multi-row inserts for the staging load; never row-by-row. Biggest L-phase win.
- **Streaming extraction** — paginate Dataverse and stream into load; never hold a whole agent in memory.
- **Respect source throttling** — Dataverse service-protection limits, Vertex AI, and Gemini deploy quotas are honored with backoff + backpressure, not blind fan-out (429s → retry, not ban).
- **Connection pooling** — pgBouncer; many workers, few DB connections.
- **Idempotent hash-keyed upserts** (`UNIQUE (tenant_id, external_id, source_hash)`) — what makes aggressive parallelism and retries safe.
- **LLM SYNTHESIZE is the bottleneck**, not the DB — cache by capability hash, batch, give it the highest concurrency (I/O-bound + rate-limited). DB stages are cheap by comparison.

## 12. Runtime dispatch (the deployed output — separate lifecycle)

```
User → Root Agent (routes on connected-agent descriptions)
     → Connected Agent (selects capability)
     → Capability tool → Cloud Workflow → Response
```
The dispatch layer (Cloud Function) maps function calls → sub-agent (Interactions API) or workflow (Executions API), per `agent-map`. Owned and monitored as a runtime product, not part of the migration pipeline. **Measure hop latency/cost on a pilot agent before committing all components.**

---

## 13. API surface (control plane)

```
POST   /tenants/{t}/runs                 start a migration (agent scope, granularity knob, dry_run)
GET    /tenants/{t}/runs/{id}            status + fidelity summary
GET    /tenants/{t}/runs/{id}/report     business mapping report
GET    /tenants/{t}/review               capabilities where needs_human_review
POST   /tenants/{t}/review/{cap}/approve approve → resume to EMIT
POST   /tenants/{t}/runs/{id}/deploy     promote a dry-run to a real deploy
```

---

## 14. Testing strategy

- **Golden fixtures:** real exported topic YAML → asserted Capability IR (stages 1–2, deterministic).
- **Graph tests:** state-threading and redirect-clustering against hand-built cases.
- **Synthesis contract tests:** LLM output validated against JSON schema + verbatim-lock assertions; snapshot review.
- **Replay harness (fidelity):** feed a capability's trigger phrases to the deployed agent, diff behavior vs expected. This is the objective fidelity evidence for the client.

---

## 15. Build phases

| Phase | Deliverable | LLM? |
|---|---|---|
| 1 | Ingestion + PARSE + NORMALIZE + lossless store + IR schema | No |
| 2 | ANALYZE (classify + capability + domain + graph) | Optional |
| 3 | GROUP + connected-agent planner (granularity knob) | No |
| 4 | State-threading + SYNTHESIZE (guardrailed) + VALIDATE | Yes |
| 5 | EMIT/DEPLOY adapter + business mapping report | No |
| 6 | Runtime dispatch + replay harness | No |

Ship dry-run end-to-end at Phase 5; runtime at Phase 6.

---

## 16. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| Generative agent won't enforce deterministic flows | Flag `partial|manual`; recommend Dialogflow CX/ADK for strict flows |
| LLM drift in instruction synthesis | IR-in, JSON-schema-out, node citations, verbatim-lock, snapshot tests |
| Gemini Enterprise API schema drift | Emitter adapter + version pinning |
| Runtime hop latency/cost | Domain-grouping reduces agent count; measure on pilot before full rollout |
| Classic-orchestration source with deep trees | Detect mode in NORMALIZE; route deep flows to higher-fidelity targets |
```
