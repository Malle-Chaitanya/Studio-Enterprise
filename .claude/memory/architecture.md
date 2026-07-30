# Memory: Architecture

Deep reference for how CloudFuze Studio Migrate is built. Quick version lives in
[CLAUDE.md](../../CLAUDE.md); the skill is [.claude/skills/architecture/SKILL.md](../skills/architecture/SKILL.md).

## Pipeline

```
extract → IR → map → create → verify → report
```

| Stage | Module | Does |
|-------|--------|------|
| extract | `services/dataverse.ts`, `dataverseSnapshot.ts` | Pull full agent from Dataverse → normalized `AgentIR` |
| map | `services/mapper.ts`, `topicCompiler.ts`, `topicsEmit.ts`, `knowledgeClassifier.ts`, `knowledgePlanner.ts` | `AgentIR` → Gemini `lowCodeAgentDefinition` + instruction synthesis |
| create | `services/gemini.ts`, `geminiAgentFiles.ts`, `geminiDataStore.ts`, `adkDeployer.ts` | Create / publish / share via Discovery Engine `v1alpha`, with quota backoff |
| verify | `services/verify.ts` | Smoke-test each migrated agent |
| report | `services/report.ts` | Per-agent fidelity report (mapped / partial / lost / needs-review) |

Supporting services: `assess.ts`, `scope.ts` (scope → work-list), `destination.ts`,
`organizationProfile.ts`, `quota.ts`, `rateLimiter.ts`, `stateThreading.ts`, `topicGraph.ts`,
`importReconcile.ts`.

## The two-phase engine (`orchestrator.ts`)

```
PHASE 1 EXTRACT:  Copilot/Dataverse → transform → LOAD into Mongo `stagedAgents`
PHASE 2 INSERT:   read staged rows → create/publish/share/verify in Gemini
```

- Staging in the DB **decouples** the phases: a failed insert run replays from staged rows
  without re-extracting. This is the core resilience decision.
- **Bounded concurrency**: `mapPool(items, limit, fn)`. `CONCURRENCY=5` (Phase 1, Dataverse
  reads); `INSERT_CONCURRENCY=3` (Phase 2 — Gemini writes hit the tighter Discovery Engine write
  quota; combined with jittered backoff this cuts retries).
- Gemini calls back off on `429`/`503`.

## SSE progress

- `runMigration()` is an async generator the `/api/migrate/stream` route consumes.
- `EventQueue` — a single-consumer async queue — lets concurrent workers `push` events while the
  route drains them in order. Events are the `ProgressEvent` union: `log | progress | agent | done`.
- Logs are mirrored to the server console as ASCII (the Windows code page mangles `→ ── · ⚠`).

## Data model — 9 Mongo collections

Bootstrapped idempotently in `db/mongo.ts` on startup via the `db/core.ts` cached-client factory
(native `mongodb` driver, **no ODM**). Every migration-scoped collection carries `appUserId`.

1. `appUsers` — login accounts (email unique, bcrypt).
2. `authSessions` — OAuth tokens per user+provider+account.
3. `migrationSessions` — DB-backed session store, **TTL** 1h (`_id` = session id).
4. `environmentsCache` — discovered environments + inventory per tenant.
5. `migrationRuns` — one doc per run (scope + plan snapshot + summary).
6. `migrationResults` — one `MigrationResult` per agent per run.
7. `agentIRCache` — extracted `AgentIR` + `MappedAgent` (audit / re-run without re-extract).
8. `migrationLogs` — persisted SSE `ProgressEvent`s per run.
9. `stagedAgents` — the extract→load→insert staging area.

All repo writes are **best-effort** (guard `isDbConnected()`, never throw) — the app runs
without persistence (in-memory session fallback).

## Auth

- **Microsoft** (`auth/microsoft.ts`): interactive admin OAuth for identity; **app-only
  `client_credentials`** for Dataverse extraction (Graph `.default` + `offline_access`; no
  delegated Dynamics scope — that would trigger `AADSTS65001`).
- **Google** (`auth/google.ts`): CloudFuze **service account**. The customer admin always
  signs in via OAuth; the SA then uses **Direct IAM** on the project (tried first, no
  impersonation) or **Domain-Wide Delegation** to impersonate that admin. There is no dev
  bypass — every connect goes through real OAuth.
- Destination engine is always **discovered** (`resolveDestination`), never hardcoded.

## Config (`config.ts`)

Central, Zod-validated, fail-fast (exits with a clear message on missing/invalid env). Secrets
from env / Secret Manager only.

## Frontend

React 18 + Vite 6 + `react-router-dom` 6. Pages under `web/src/pages/`, typed fetch wrappers in
`web/src/api.ts`, hand-rolled CSS in `styles.css` (no UI library). OAuth via popup + `postMessage`.