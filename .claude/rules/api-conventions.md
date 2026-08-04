# Rule: API Conventions (CloudFuze Studio Migrate)

How this project structures its HTTP API. gstack `/review` reads these rules.

## Routing

- One Express `Router` per domain file in [server/src/routes/](../../server/src/routes/):
  `auth`, `explore`, `destination`, `migrate`. Mounted under `/api/<domain>` in
  [server/src/server.ts](../../server/src/server.ts).
- Export the router as a named export (`export const migrateRouter = Router()`), never a
  default export.
- Health check lives at `GET /api/health` and returns `{ status, tool, phase, serviceAccount }`.

## Request/response shape

- **Request bodies** are read as a typed cast off `req.body` and validated inline. Prefer a
  Zod schema for anything non-trivial (config already sets the precedent).
- **Success**: `res.json(<object>)`. Return plain data objects, not envelopes.
- **Errors**: `res.status(<code>).json({ error: '<snake_case_code>', detail?: '<message>' })`.
  The `error` field is a stable machine-readable code the web client switches on; `detail`
  is a human string. Examples in use: `session_not_found` (404), `scope_required` (400),
  `no_plan` (400), `plan_failed` (500).
- Use the early-return `void` pattern for guards:
  `if (!session) return void res.status(404).json({ error: 'session_not_found' });`

## Sessions

- The client passes a `session` id (query param on GETs, body field on POSTs). Resolve it
  with `getSession()` / `getSession(req.query.session as string)` and 404 if missing.
- Session state (tokens, plan, discovered inventory) is server-side in the
  `migrationSessions` collection with a TTL — the client only ever holds the id.

## Streaming (SSE)

- Long-running work streams progress as **Server-Sent Events**, not polling. `GET
  /api/migrate/stream?session=<id>` sets `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `Connection: keep-alive` and drains an `EventQueue`.
- Progress events follow the `ProgressEvent` union in
  [server/src/types.ts](../../server/src/types.ts): `log` | `progress` | `agent` | `done`.
  Add new event kinds to that union — never send ad-hoc event shapes.

## External API calls (Graph / Dataverse / Discovery Engine)

- All outbound calls are **client-agnostic**: discover the project's engine at runtime; never
  hardcode a Gemini engine/app id.
- Respect quotas: Gemini writes back off on `429`/`503` (see `services/gemini.ts` and
  `services/rateLimiter.ts`). New write paths must go through the same backoff.
- Extraction from Dataverse uses **app-only** (`client_credentials`) tokens; Gemini uses the
  **service account** (direct IAM or Domain-Wide Delegation). Do not cross these.

## Web client (`web/src/api.ts`)

- One typed async wrapper per endpoint. Throw a plain `Error(<code>)` on non-OK responses so
  pages can `catch` and show a message. OAuth flows open a **popup** and resolve on
  `postMessage` — the SPA never navigates away.