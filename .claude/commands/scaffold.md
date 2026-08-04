---
description: Scaffold a new CS_GE building block (service, route, repo, mapper stage, or web page) following project conventions.
---

# /scaffold — new CS_GE building block

Create a new component wired to the project's conventions. Read `$ARGUMENTS` for the kind and
name (e.g. `service knowledgeDedup`, `route webhooks`, `repo auditEvents`, `page Review`).
Follow the matching template below. Confirm the plan, then create files.

## `service <name>` → `server/src/services/<name>.ts`
- Pure-ish domain logic. Imports `config`, `logger`, other services, auth — **never** routes or
  Express types. Extraction services never call Gemini; Gemini services never call Dataverse.
- Export named functions. Use `import type` for types from `../types.js`. ESM `.js` specifiers.
- Fan-out to external APIs goes through a bounded pool + the shared backoff — never raw
  `Promise.all` at Dataverse/Discovery Engine.

## `route <name>` → `server/src/routes/<name>.ts`
- `export const <name>Router = Router();` Mount it in `server.ts` under `/api/<name>`.
- Resolve `session` via `getSession`, 404 if missing. Errors as
  `{ error: '<snake_case>', detail? }`. Long work → SSE with a `ProgressEvent` union member.

## `repo <name>` → `server/src/db/repos/<name>.ts`
- One collection. Guard every write with `isDbConnected()`; return quietly if Mongo is down
  (best-effort). Scope every query by `appUserId`.
- Add the collection + its indexes to `ensureCollections()` in `db/mongo.ts`. Multi-tenant
  index first (`{ appUserId: 1, ... }`).

## `mapper-stage <name>` → extend `server/src/services/mapper.ts` (or a new `services/<name>.ts`)
- Consumes `AgentIR`, produces part of `MappedAgent`. Any lossy/heuristic step MUST push a
  `FidelityNote`. Never invent content to fill a gap — record `needs-review` instead.

## `page <Name>` → `web/src/pages/<Name>.tsx`
- React function component, `.tsx` specifiers, typed props. Add the route in `App.tsx` and a
  step in the `STEPS` stepper if it's part of the wizard. Data via a typed wrapper in
  `web/src/api.ts`. Style with existing classes in `styles.css` (no new UI library).

After scaffolding: run `npm run typecheck` in the affected package and report what was created
and where it's wired in.