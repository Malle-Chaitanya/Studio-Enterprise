---
name: api-design
description: How CloudFuze Studio Migrate shapes its own API — per-domain Express routers, snake_case error codes, session-id contract, the ProgressEvent SSE union, and the external Graph/Dataverse/Discovery-Engine call conventions. Use when adding or changing CS_GE endpoints or service calls.
---

# Skill: CS_GE API Design

Project-specific API shape. Rules digest in
[.claude/rules/api-conventions.md](../../rules/api-conventions.md); this skill is the working
guide with examples.

## Internal HTTP API

- **One router per domain** in `routes/`, named export, mounted `/api/<domain>` in `server.ts`:
  `authRouter`, `exploreRouter`, `destinationRouter`, `migrateRouter`.
- **Session contract**: the client holds only an opaque `session` id (query param on GET, body
  field on POST). Server resolves it and 404s if missing:
  ```ts
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  ```
- **Responses**: bare data objects on success (`res.json(data)`), no envelope.
- **Errors**: `res.status(code).json({ error: '<snake_case_code>', detail? })`. Codes in use:
  `session_not_found`, `scope_required`, `no_plan`, `plan_failed`, `disconnect_failed`. Add new
  codes in the same style; the web client switches on `error`.
- **Validation**: typed cast off `req.body` + guards; Zod for anything non-trivial (config sets
  the precedent). Body capped at 2 MB.

## Streaming (the long-running path)

Migrations stream **SSE**, they do not poll. `GET /api/migrate/stream?session=<id>`:
```ts
res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
```
Every event is a member of the `ProgressEvent` union in `types.ts`:
`{ type:'log' } | { type:'progress' } | { type:'agent' } | { type:'done' }`. New event kinds go
**into that union** — never emit an unlisted shape. The orchestrator emits via the `EventQueue`;
the route just drains it.

## The plan → stream two-step

`POST /api/migrate/plan` resolves a `MigrationScope` into a `ResolvedPlan`, stores it on the
session, and returns a preview. `GET /api/migrate/stream` then runs the stored plan. Keep this
split — planning is idempotent and previewable; streaming executes.

## External API conventions

- **Client-agnostic**: discover the destination engine at runtime (`resolveDestination`); never
  hardcode an id.
- **Right token for the job**: app-only for Dataverse, service account (IAM/DWD) for Gemini.
- **Quota-safe**: all Gemini writes go through the shared backoff (`429`/`503`) and a bounded
  pool. New outbound write paths must reuse it.

## Web wrappers (`web/src/api.ts`)

One typed async function per endpoint; `throw new Error('<code>')` on non-OK so pages can
`catch`. OAuth uses a **popup** that posts the result back — the SPA never navigates away.