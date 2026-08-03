# Rule: Code Style (CloudFuze Studio Migrate)

Project-specific coding conventions. gstack `/review` reads these rules.

## TypeScript & modules

- **ESM everywhere.** `server/` uses `"type": "module"`. Relative imports in server code
  MUST carry the `.js` extension even though the source is `.ts`
  (`import { config } from './config.js'`). Web code (Vite) uses `.ts`/`.tsx` specifiers
  (`import { Home } from './pages/Home.tsx'`). Match the neighbors.
- **`import type` for types.** Keep type-only imports separate:
  `import type { AgentIR } from './types.js'`.
- **Strict TS.** No `any` in app code unless narrowing an external payload immediately.
  Prefer `unknown` + a Zod parse or a typed cast at the boundary.
- **`tsc --noEmit` is the gate.** There is no ESLint/Prettier in CI — run
  `npm run typecheck` in both `server/` and `web/` before every commit. Zero errors.

## Naming

- Files: `camelCase.ts` for modules (`geminiAgentFiles.ts`), `PascalCase.tsx` for React
  components/pages (`SelectMap.tsx`).
- Types/interfaces: `PascalCase` (`AgentIR`, `MigrationResult`, `GeminiDestination`).
- The neutral extraction shape is always called **IR** (`AgentIR`, `TopicIR`,
  `KnowledgeSourceIR`) — do not rename or invent parallel shapes.
- Error codes returned to the client are `snake_case` string constants
  (`session_not_found`, `plan_failed`). See [api-conventions.md](api-conventions.md).

## Comments

- Comment the **why**, not the what. This codebase's comments explain *why* a decision was
  made (quota backoff, idempotency, ASCII-mirroring logs for the Windows console). Preserve
  that density when editing — do not strip explanatory comments.
- Use JSDoc `/** ... */` on exported functions and non-obvious types.

## Async & errors

- Prefer `async/await`. Use bounded-concurrency pools (`mapPool`) for fan-out over
  external APIs — never fire an unbounded `Promise.all` at Dataverse or Discovery Engine.
- In best-effort paths (persistence writes, log mirroring, the orchestrator) **never throw** —
  catch, log via `logger`, and continue. The app must survive a Mongo outage.
- Use the shared Pino `logger` ([server/src/logger.ts](../../server/src/logger.ts)). Never
  `console.log` in app code (the one `console.error` in `config.ts` is the deliberate
  fail-fast exception).

## Diagnostic scripts

`server/src/spikes/_diag_*.ts`, `_test_*.ts`, `_demo_*.ts`, `_poc_*.ts`, `_probe_*.ts`,
`_spike_*.ts`, `_dump_*.ts`, `_prep_*.ts`, `_register_*.ts`, `_del_*.ts` are throwaway
spikes, all collected under `server/src/spikes/`, run via `tsx`. They are **not** app code: exempt from the strictness above, not
imported by `server.ts`, and should not be refactored or "cleaned up" as part of feature
work.