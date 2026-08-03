# Memory: Progress & Status

Living snapshot of where CloudFuze Studio Migrate is. Update as phases land. (Assumptions here
are inferred from the repo state at scaffold time — 2026-07-28 — and marked *[assumption]*.)

## Current status

- **Phase 1 — agents only** is the active scope: extract → map → create → verify → report is
  implemented end-to-end (`orchestrator.ts` + `services/*`), with SSE progress and Mongo
  persistence (9 collections). *[assumption: this is the working build]*
- Two-phase EXTRACT/INSERT engine with DB staging is in place and resumable.
- Auth works for both clouds: Microsoft app-only (Dataverse) + Google SA (Direct IAM / DWD).
  Google connect is always real OAuth (the dev `bypass` mode was removed).
- Topics migration has a production design (`docs/architecture/topics-migration-production.md`)
  and code (`topicCompiler.ts`, `topicGraph.ts`, `topicsEmit.ts`, `topicsMigration.ts`).
- Knowledge sources: classifier + planner (`knowledgeClassifier.ts`, `knowledgePlanner.ts`),
  file attachment via `agentFiles`, with a migration playbook in `docs/`.
- Heavy diagnostic-spike surface (`_diag_*`, `_test_*`) reflects active API probing against real
  tenants.

## Known limitations / open items

- **No formal test runner** — testing is via `_test_*` tsx spikes + in-pipeline `verify.ts` +
  gstack `/qa`. A `vitest` suite for the pure transforms is the recommended next step
  (see [.claude/rules/testing-standard.md](../rules/testing-standard.md)).
- **Flows/workflows not migrated** — Phase 1 is agents only; flows are a later phase.
- **Gemini edition visibility gap** — migrated agents don't appear in Standard/Plus UIs (governed
  gallery). Documented, not fixable on our side; set customer expectations accordingly.
- **Managed/prebuilt & AI-Builder-only agents** — can have thin extractable content; migration is
  honest about this (`isManaged`/`thinContent` + fidelity notes) rather than fabricating.
- **Discovery Engine write quota** — the real throughput ceiling; mitigated by low insert
  concurrency + backoff. Large tenants may need staged runs. See `docs/SUPPORT-TICKET-AGENT-QUOTA.md`.

## Next phases (indicative)

1. Add a `vitest` unit suite for `mapper` / `topicCompiler` / `knowledgeClassifier` / `scope`.
2. Flows/workflows migration (Phase 2 of the product).
3. Harden multi-tenant operational tooling (per-tenant run history UI).

## How to verify the current build quickly

- `cd server && npm run typecheck && npm run dev`; `cd web && npm run dev`; open `:5173`.
- `GET /api/health` should return `{ status:'ok', serviceAccount:true }` once creds are set.
- Run gstack `/qa http://localhost:5173` through Connect → Report.