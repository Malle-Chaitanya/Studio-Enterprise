# Memory: Architectural Decisions

Dated log of decisions that shape CloudFuze Studio Migrate. Add an entry (newest first) whenever
you change the `AgentIR` shape, the DB schema, the phase model, the auth model, or the `.claude/`
scaffold. Format: **date — decision — why — impact**.

---

## 2026-08-03 — Persist per-tenant Entra credentials in GCP Secret Manager (for connector auto-provisioning)

- **Decision**: While wiring up the SharePoint native-connector migration path (`geminiConnector.ts` →
  orchestrator), extended the "never persist the customer's Entra `clientSecret`" rule with one
  addition: CloudFuze now MAY persist it, but only (a) in **GCP Secret Manager** under CloudFuze's
  own project — never Mongo, never plaintext, never the customer's project — and (b) scoped **per
  tenant**, not per site. Mongo (`entraAppCredentials` repo) stores only a `secretName` reference,
  never the value. First site under a new tenant still requires the admin to submit
  Client ID/Secret/Tenant ID once; every subsequent *new* site under that same tenant reuses the
  stored credential with zero further admin interaction.
- **Why**: Without this, "no persistence" meant every previously-unseen SharePoint site — even
  under an already-onboarded tenant — required the admin to re-enter the same Entra app's secret.
  That's real, avoidable friction for an enterprise customer with many sites across many agents.
  Scoping by tenant (not caching the raw secret anywhere in our own DB, not going further to
  "store it forever with no re-consent path") keeps the blast radius of a CloudFuze database
  breach unchanged — Secret Manager, not Mongo, is the thing an attacker would need to compromise,
  and that's GCP's own hardened, audited, IAM-scoped secret store (this project's existing
  documented pattern in `config.ts` for CloudFuze's own static secrets), not a bespoke encryption
  scheme we'd have to build and maintain ourselves.
- **Impact**: New service `services/secretManager.ts` (plain REST calls, no new npm dependency —
  reuses the existing `cloud-platform` SA scope) and new repo `db/repos/entraAppCredentials.ts`
  (`{appUserId, tenantId}`-unique, non-secret fields only). `routes/destination.ts`'s connector
  setup flow now checks this store before requiring credentials in the request body. Revocation/
  rotation UX (what happens when a customer rotates their Entra secret, or wants CloudFuze's
  stored copy deleted) is NOT yet designed — flag as a follow-up before this ships to a real
  customer, not an oversight to silently paper over.

---

## 2026-08-02 — Agent-publish problem: ADK confirmed as the only viable path; A2A and Dialogflow CX rejected
- **Decision**: For the "migrated agent stays PRIVATE forever on Standard/Plus, no publish button
  exists anywhere" gap (see [docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md](../../docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md)),
  evaluated four `agents.create` definition types against official Google docs + this repo's own
  live tenant tests. **Re-activating the already-built ADK/Reasoning-Engine path
  (`server/src/services/adkDeployer.ts`, currently gated off by `needsAdkDeployment` returning
  `false`) is the only viable production direction.** A2A (`a2aAgentDefinition`) and Dialogflow CX
  registration (`dialogflowAgentDefinition`) are both **rejected** as build targets.
- **Why**: ADK is the only path with a *live-proven* (not just documented) `state: ENABLED` +
  gallery-visible outcome, and Google's Vertex AI Agent Engine runs the compute — CloudFuze never
  becomes a hosting company. A2A's "Agent Card" is only a discovery pointer to an endpoint the
  developer must host and run themselves (Google's own docs name Cloud Run explicitly); adopting
  it would mean building an entire second agent-runtime product from scratch for no proven
  advantage over ADK, on a feature still marked Pre-GA/Preview, whose traffic bypasses Agent
  Gateway governance policies entirely (a real concern for the security-conscious enterprise
  admins who are CS_GE's actual buyers). Dialogflow CX registration never shows a `state` field in
  any official example response (unverified whether it's even gallery-visible), confirmed requires
  a *second*, unrelated Draft→Version→Environment publish step inside Dialogflow's own console, and
  this repo's own `_diag_dialogflow_spike.ts`/`_diag_dialogflow_user.ts` already hit a live 403 from
  org governance/VPC-SC trying to create a CX agent programmatically — a wall real enterprise
  customers are likely to also have. Both alternatives would additionally require a brand-new
  IR-to-target mapper; CX especially, since its flow/intent paradigm doesn't map cleanly onto
  Copilot Studio's generative topic model.
- **Impact**: Next engineering step is re-enabling ADK as an explicit, cost-disclosed customer
  opt-in (never automatic — real ongoing Reasoning Engine compute cost lands on the customer's
  project) rather than building A2A or Dialogflow CX support. While re-enabling, fix a related
  honesty gap: the ADK branch in `orchestrator.ts` (~line 742) unconditionally sets
  `deployed = true, shared = true`, unlike the low-code branch which correctly mirrors whether the
  source Copilot agent was actually published vs. a draft — needs the same check before shipping.
  Separately and at higher priority: `lowCodeAgentDefinition` (the current default create path) no
  longer appears anywhere in Google's live v1alpha discovery document — verify it still works
  against a real tenant before anything else, since that risk is independent of and bigger than
  the publish-visibility question.

## 2026-07-30 — Public-website knowledge-source handling removed entirely
- **Decision**: Removed all "public website" special-casing from knowledge migration:
  the classifier's website rule + `websiteOwnership()` heuristic in `knowledgeClassifier.ts`,
  the website-folding action in `knowledgePlanner.ts`, the `buildKnowledgeReferencesAppendix()`
  workaround and `unsupportedKnowledgeHandling` option in `mapper.ts`, and the
  `knowledgeHandling` field threaded through `types.ts` → `orchestrator.ts` →
  `routes/migrate.ts` → `web/src/api.ts` → `Migrate.tsx`. A public website knowledge source
  now falls through to the generic unrecognized-kind `manual-review` path — the URL reference
  is still preserved losslessly on `AgentIR` and surfaced in the report, but nothing is
  auto-created and nothing is written into the migrated agent's instructions.
- **Why**: Gemini Enterprise assistant apps can't attach a website data store at all (confirmed,
  see [docs/knowledge-sources-migration-playbook.md §4.1](../../docs/knowledge-sources-migration-playbook.md)),
  so the only thing the old "appendix" path did was paste raw URLs into the agent's instruction
  text — not real grounding, just text the model happens to see. The user judged that workaround
  not worth keeping.
- **Impact**: `OrganizationProfile` / `organizationProfile.ts` (Graph `verifiedDomains` + Google
  Workspace domain discovery) is now unused dead code — kept in place on request (not deleted)
  in case a future feature wants org-domain discovery; it still runs once per migration and logs
  its result in `orchestrator.ts`, at the cost of two now-pointless API calls per run. The
  low-level Gemini website-data-store executor (`createDataStore('website', ...)` +
  `addTargetSite` + `attachDataStoreToEngine` in `geminiDataStore.ts`) was left untouched but is
  now fully orphaned — nothing calls it except the standalone `_diag_website*.ts` spikes.

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