# Rule: Architecture Boundaries (CloudFuze Studio Migrate)

The layering that keeps the extract→map→create→verify pipeline maintainable. gstack
`/review` reads these rules. See [.claude/memory/architecture.md](../memory/architecture.md)
for the full picture.

## The two phases must stay separate

```
PHASE 1 EXTRACT:  Copilot/Dataverse → transform → LOAD into Mongo `stagedAgents`
PHASE 2 INSERT:   read staged rows → create/publish/share/verify in Gemini
```

- Extraction code (`services/dataverse.ts`, `services/dataverseSnapshot.ts`) never calls
  Gemini. Gemini write code (`services/gemini.ts`, `services/geminiAgentFiles.ts`,
  `services/adkDeployer.ts`) never calls Dataverse. The **staging DB is the only handoff**.
- This decoupling is what makes a failed insert run retryable without re-extracting. Do not
  short-circuit it by writing Gemini agents directly from extraction.

## Layer responsibilities

| Layer | Directory | May depend on | May NOT do |
|-------|-----------|---------------|------------|
| Routes | `routes/` | services, sessionStore, orchestrator | contain business logic, talk to Mongo directly, call external APIs |
| Orchestrator | `orchestrator.ts` | services, repos, sessionStore | contain HTTP concerns, own SSE transport (routes drain the queue) |
| Services | `services/` | other services, `config`, `logger`, auth | import routes; know about Express `req`/`res` |
| Repos | `db/repos/` | `db/core`, `config`, `types` | contain business logic; be called from routes directly |
| DB core | `db/core.ts`, `db/mongo.ts` | `mongodb`, `config` | know about domain types beyond generic persistence |
| Auth | `auth/` | `config`, `google-auth-library` | know about migration domain |

Dependencies point **down** (routes → orchestrator → services → repos → db). Never upward.

## The IR is the contract

- `AgentIR` (and `TopicIR`, `KnowledgeSourceIR`) in [server/src/types.ts](../../server/src/types.ts)
  is the **platform-neutral boundary** between "everything Copilot" and "everything Gemini".
  Extraction produces IR; mapping consumes IR. Neither side reaches across it.
- **Lossless**: extraction captures everything the target could need, even fields v1 doesn't
  map. Unmapped fields ride along on `AgentIR.unmapped` and surface in the report — never drop
  them to make a shape cleaner.
- Changing the IR shape is an architectural decision → Architect sign-off + a note in
  [.claude/memory/decisions.md](../memory/decisions.md).

## Persistence rules

- One repo module per collection under `db/repos/`. Routes/orchestrator call repos, not the
  driver. Collections + indexes are created idempotently in `db/mongo.ts` on startup.
- No ODM (Mongoose/Prisma) — the native `mongodb` driver only. This is deliberate.
- Persistence is **best-effort**: every repo write checks `isDbConnected()` and returns quietly
  if Mongo is down. The pipeline must run without persistence.

## Client-agnostic destinations

- Never hardcode a Gemini engine/app id. Resolve the destination from the connected project at
  runtime (`resolveDestination`). The tool must work against any customer project unchanged.