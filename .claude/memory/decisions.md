# Memory: Architectural Decisions

Dated log of decisions that shape CloudFuze Studio Migrate. Add an entry (newest first) whenever
you change the `AgentIR` shape, the DB schema, the phase model, the auth model, or the `.claude/`
scaffold. Format: **date — decision — why — impact**.

---

## 2026-07-28 — gstack command renames in the `.claude/` scaffold
- **Decision**: When generating `.claude/commands/`, the scaffold's `review.md` was created as
  **`team-review.md`** to avoid colliding with gstack's reserved `/review`. `deploy.md` was kept
  (not removed) because CS_GE has genuine project-specific deploy logic gstack's
  `/land-and-deploy` doesn't know (two build targets, its own Mongo instance on 27019,
  service-account/Secret-Manager setup, the ADK `server/scripts/adk_deploy.py` path).
- **Why**: gstack is installed globally; slash-command names must not collide, and generic
  workflows should defer to gstack while project-specific ones stay local.
- **Impact**: Use `/team-review` for the CS_GE checklist and gstack `/review` for general bugs.
  No pre-existing custom commands/skills existed in `.claude/` at scaffold time, so there were no
  *other* collisions to rename. `.claude/settings.local.json` already existed and was left as-is.

## (undated, from initial build) — DB-backed staging decouples extract from insert
- **Decision**: Migration runs in two phases with Mongo `stagedAgents` as the handoff, not a
  single streaming pass.
- **Why**: A failed Gemini insert run must be retryable without re-hitting Dataverse; staging
  makes the pipeline resumable and the phases independently scalable.
- **Impact**: Extraction code never calls Gemini and vice-versa; the boundary is enforced in
  [.claude/rules/architecture-boundaries.md](../rules/architecture-boundaries.md).

## (undated) — Native MongoDB driver, no ODM
- **Decision**: Use the `mongodb` driver directly with one repo per collection; no Mongoose/Prisma.
- **Why**: Full control over indexes/queries, matches the GEM_CO reference, keeps the layer thin.
- **Impact**: Repos live in `db/repos/`; collections/indexes ensured idempotently in `db/mongo.ts`.

## (undated) — Best-effort persistence
- **Decision**: Every persistence write is best-effort (`isDbConnected()` guard, never throws);
  the app boots and migrates even if Mongo is down (in-memory session fallback).
- **Why**: A DB outage must not block a customer migration.
- **Impact**: Never assume a write succeeded; never `await` a repo write as if it's authoritative.

## (undated) — Client-agnostic destination discovery
- **Decision**: The Gemini engine/app id is discovered from the connected project at runtime
  (`resolveDestination`), never hardcoded.
- **Why**: The tool must work against any customer's project unchanged.
- **Impact**: No engine id literals anywhere; a hardcoded id is a review blocker.

## (undated) — Read the REAL agent content (fidelity over filler)
- **Decision**: Extract the actual `GptComponentMetadata.instructions`, full topic set, and AI
  Builder prompts from Dataverse; synthesize a faithful Gemini instruction.
- **Why**: The Python POC discarded real instructions and regex-scraped generic filler — low
  fidelity. This rebuild's entire value is behavioral fidelity + honest reporting.
- **Impact**: `AgentIR` is lossless; lossy mappings must emit `FidelityNote`s.

## (undated) — CS_GE runs its own MongoDB instance (port 27019)
- **Decision**: Default `MONGO_HOST=mongodb://localhost:27019`, db `csge`.
- **Why**: Avoid collisions with sibling projects on the same machine (GEM_CO 27017, itsm 27018).
- **Impact**: Local/deploy setup must point at the CS_GE instance.