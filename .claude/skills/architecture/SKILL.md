---
name: architecture
description: The CloudFuze Studio Migrate architecture in depth — the two-phase extract/insert engine, AgentIR contract, SSE EventQueue, bounded-concurrency pools, the 9-collection Mongo schema, and the OAuth/service-account auth model. Use when designing or navigating CS_GE structure.
---

# Skill: CS_GE Architecture

Teaches how this system is built so you can design changes without re-scanning the tree. Full
narrative in [.claude/memory/architecture.md](../../memory/architecture.md).

## The pipeline

```
extract → IR → map → create → verify → report
```

Realized as a **two-phase** engine in `orchestrator.ts`:

- **PHASE 1 EXTRACT** — `services/dataverse.ts` pulls each Copilot agent (real instructions,
  topics, knowledge refs, entities) → normalizes to `AgentIR` → LOADs into Mongo `stagedAgents`.
- **PHASE 2 INSERT** — reads staged rows → `services/mapper.ts` maps `AgentIR` → Gemini
  `lowCodeAgentDefinition` → `services/gemini.ts` creates/publishes/shares → `verify.ts`
  smoke-tests → `report.ts` builds the fidelity report.

The DB between the phases is the decoupling point: a failed insert run replays from staged rows
without re-hitting Dataverse. **Do not** collapse the phases.

## AgentIR — the contract

`AgentIR` (+`TopicIR`, `KnowledgeSourceIR`) in `server/src/types.ts` is the platform-neutral
boundary. Extraction *produces* it; mapping *consumes* it. It is **lossless** — everything the
target could need is captured, and anything v1 can't map rides on `AgentIR.unmapped` to surface
in the report. Changing its shape is an architectural decision (Architect sign-off +
[decisions.md](../../memory/decisions.md)).

## Concurrency & streaming

- `mapPool(items, limit, fn)` runs fan-out with bounded concurrency: `CONCURRENCY=5` for Phase 1
  (Dataverse reads), `INSERT_CONCURRENCY=3` for Phase 2 (Gemini writes hit the tighter Discovery
  Engine quota). Gemini calls back off on `429`/`503`.
- Progress is **SSE**. `EventQueue` (single-consumer async queue) lets concurrent workers `push`
  `ProgressEvent`s while the `/api/migrate/stream` route drains them in order. `runMigration` is
  an async generator the route consumes.

## Persistence — 9 collections

Bootstrapped idempotently in `db/mongo.ts` on startup, via the `db/core.ts` cached-client
factory (native driver, no ODM). Every migration-scoped collection is keyed by `appUserId`:
`appUsers`, `authSessions`, `migrationSessions` (TTL), `environmentsCache`, `migrationRuns`,
`migrationResults`, `agentIRCache`, `migrationLogs`, `stagedAgents`. One repo module per
collection under `db/repos/`; all writes best-effort.

## Auth model

- **Microsoft**: interactive admin OAuth for identity; **app-only `client_credentials`** for
  Dataverse extraction (no delegated Dynamics scope — avoids `AADSTS65001`).
- **Google**: a CloudFuze **service account** reaches the customer's Gemini project via
  **Direct IAM** (prod, tried first) or **Domain-Wide Delegation** (impersonating the admin).
  `bypass` mode is dev-only. The destination engine is always **discovered**, never hardcoded.

## Design principles (non-negotiable)

Lossless extraction · behavioral fidelity · honesty over overclaiming · recommendations not
silent decisions · client-agnostic · idempotent/resumable · multi-tenant.