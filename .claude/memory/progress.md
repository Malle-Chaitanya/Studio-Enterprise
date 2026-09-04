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
4. **Make the pipeline genuinely ELT, not ETL.** Today EXTRACT transforms Dataverse into
   `AgentIR` and only then LOADs it into `stagedAgents` -- the verbatim source payload is
   thrown away in the same breath that produces the IR. `rawAgents` captures it, but it is
   off unless `RAW_RETENTION_DAYS` is set, and it is a debugging aid rather than the
   pipeline's input.

   Land the raw Dataverse payloads FIRST, then transform out of Mongo:

       EXTRACT -> LOAD raw -> TRANSFORM (raw -> AgentIR) -> INSERT into Gemini

   Why it is worth doing:
   - **A mapper change becomes replayable.** Every mapper fix today needs a fresh extraction
     against a live tenant to test, which is why the fidelity work leans on `_test_*` probes
     against a real environment. With raw stored, the transform re-runs offline over the
     exact bytes that produced a bad result.
   - **Fidelity claims become checkable after the fact.** "Nothing was dropped" is currently
     asserted by the code that does the dropping. With the source retained, a report can be
     diffed against what actually came out of Dataverse -- the honesty rule gets evidence
     instead of good intentions.
   - **Extraction stops being the expensive step to repeat.** Re-running INSERT is already
     cheap because staging decouples the phases; re-running TRANSFORM is not, and it is the
     phase that changes most often.

   Constraints this must respect:
   - Raw payloads are UNREDACTED customer data. They inherit the `rawAgents` rules --
     `appUserId`-scoped, `expiresAt` TTL enforced by Mongo, retention deliberately bounded,
     never copied into logs, dumps, or fixtures.
   - The two-phase boundary stays. This adds a stage inside EXTRACT; it does not let
     extraction reach Gemini or mapping reach Dataverse.
   - `AgentIR` remains the contract between the halves. Storing raw does not make raw the
     interface -- mapping still consumes IR.
   - Changing where the IR is produced is an architecture decision: Architect sign-off plus
     a note in `decisions.md` before code.

## How to verify the current build quickly

- `cd server && npm run typecheck && npm run dev`; `cd web && npm run dev`; open `:5173`.
- `GET /api/health` should return `{ status:'ok', serviceAccount:true }` once creds are set.
- Run gstack `/qa http://localhost:5173` through Connect → Report.