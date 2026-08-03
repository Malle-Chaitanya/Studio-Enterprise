# CloudFuze Studio Migrate — Current State (for merge)

**Snapshot date:** 2026-08-03
**Branch:** `business` (2 commits ahead of a shared root with `main`, plus a large uncommitted working tree — see [§7](#7-git-state--what-is-and-isnt-committed))
**Audience:** a teammate merging their own branch/work into this one. This is a factual snapshot, not a tutorial — it tells you what exists, what's wired up, and what's still rough, so a merge doesn't silently clobber or duplicate in-flight work.

---

## 1. What this tool does

CloudFuze Studio Migrate moves **agents** from **Microsoft Copilot Studio** (Dataverse) into **Google Gemini Enterprise** (Discovery Engine). A customer connects both clouds; the tool extracts each agent losslessly into a neutral intermediate representation (`AgentIR`), maps it to a Gemini agent, creates/publishes/shares it, verifies it, and produces a per-agent fidelity report.

Guiding principles (do not violate these in a merge):
1. **Lossless extraction** — capture everything, even what v1 doesn't map; unmapped data still surfaces in the report.
2. **Behavioral fidelity** — read real instructions/topics/AI-Builder prompts, not filler.
3. **Honesty over overclaiming** — report mapped / lost / needs-review truthfully.
4. **Recommendations, not silent decisions** — surface choices to the customer.

Phase 1 scope is **agents only**; flows/workflows are a later phase.

---

## 2. Pipeline & architecture

```
extract → IR → map → create → verify → report
```

| Stage | Module | Does |
|-------|--------|------|
| extract | `services/dataverse.ts`, `dataverseSnapshot.ts`, `dataverseTableExport.ts` | Pull agent from Dataverse → `AgentIR` |
| map | `services/mapper.ts`, `topicCompiler.ts`, `topicsEmit.ts`, `knowledgeClassifier.ts`, `knowledgePlanner.ts` | `AgentIR` → Gemini `lowCodeAgentDefinition` + instruction synthesis |
| create | `services/gemini.ts`, `geminiAgentFiles.ts`, `geminiDataStore.ts`, `geminiConnector.ts`, `adkDeployer.ts` | Create/publish/share via Discovery Engine `v1alpha`, quota backoff |
| verify | `services/verify.ts` | Smoke-test each migrated agent |
| report | `services/report.ts` | Per-agent fidelity report |

**Two-phase engine** (`orchestrator.ts`):
```
PHASE 1 EXTRACT:  Copilot/Dataverse → transform → LOAD into Mongo `stagedAgents`
PHASE 2 INSERT:   read staged rows → create/publish/share/verify in Gemini
```
Staging decouples the phases so a failed insert run is retryable without re-extracting. Extraction code never calls Gemini; Gemini write code never calls Dataverse — the staging DB is the only handoff (see `.claude/rules/architecture-boundaries.md`).

Bounded concurrency: `mapPool` with `CONCURRENCY=5` (Phase 1) and `INSERT_CONCURRENCY=3` (Phase 2, tighter because Discovery Engine's write quota is the real ceiling). Gemini calls back off on `429`/`503`.

**SSE progress**: `runMigration()` is an async generator; `EventQueue` lets concurrent workers push events while `GET /api/migrate/stream` drains them in order as the `ProgressEvent` union (`log | progress | agent | done`).

---

## 3. Data model — 12 Mongo collections (was 9)

Bootstrapped idempotently in `db/mongo.ts` on startup, native `mongodb` driver, no ODM. Every migration-scoped collection carries `appUserId`.

Original 9: `appUsers`, `authSessions`, `migrationSessions` (TTL 1h), `environmentsCache`, `migrationRuns`, `migrationResults`, `agentIRCache`, `migrationLogs`, `stagedAgents`.

**New in the uncommitted working tree** (feeding the SharePoint/OneDrive connector feature — §6):
- **`entraAppCredentials`** — unique `{appUserId, tenantId}`. Fields: `clientId` (non-secret), `secretName` (a GCP Secret Manager reference — never the plaintext secret), `createdAt/updatedAt`. Repo: `db/repos/entraAppCredentials.ts`.
- **`knowledgeConnectors`** — unique `{appUserId, kind, siteUrl}`. Fields: `kind ('sharepoint'|'onedrive')`, `siteUrl`, `collectionId`, `tenantId`, `clientId`, `operationName?`, `status ('pending'|'done'|'failed')`, `error?`, `dataStoreIds?`. Replaces the old single-connector-per-session model — a migration touching several SharePoint sites now tracks each independently. Repo: `db/repos/knowledgeConnectors.ts`.
- **`adkDeployments`** — unique `{appUserId, envUrl, sourceId, project, engine}`. Fields: `reasoningEngine`, `agentId`, `deployedAt`. Exists to dedupe Vertex AI Reasoning Engine creates (that API has no name-based idempotency, unlike low-code `agents.create`). **Currently dead at runtime** — see §8. Repo: `db/repos/adkDeployments.ts`.

All repo writes remain best-effort (`isDbConnected()` guard, never throws).

---

## 4. API surface

Routers in `server/src/routes/`, one per domain, mounted `/api/<domain>`.

### `auth.ts` — unchanged shape
Microsoft/Google connect, session, resume, disconnect, SA reachability checks.
**Note**: the local dev-bypass path (`GOOGLE_AUTH_MODE=bypass` / `GOOGLE_IMPERSONATE_EMAIL`) has been **removed entirely** — every Google connect now goes through real browser OAuth. See §7 gotcha.

### `explore.ts`
- `GET /api/explore/agent` — dropped the org-domain-ownership lookup (dead since website-ownership classification was removed, §9).
- `GET /api/explore/connectors-needed?session=&env=` **(new)** — scans every agent in an environment (bounded concurrency 5), returns deduplicated `{siteUrl, kind, agentNames[]}[]`. Error: `connectors_needed_failed` (502).

### `destination.ts`
- `POST /api/destination/sharepoint-connector` — body reshaped **per-site**: `{siteUrl, tenantId, clientId?, clientSecret?}` (was per-session `{clientId, clientSecret, tenantId, instanceUri}`). Reuses a stored Secret-Manager credential when the tenant was previously onboarded and no new secret is supplied. Treats Google `409/ALREADY_EXISTS` as idempotent success. Errors: `session_not_found` (404), `site_url_and_tenant_id_required` (400), `project_required` (400), `connector_credentials_required` (400), `connector_setup_failed` (502).
- `GET /api/destination/sharepoint-connector/status?session=&siteUrl=` — now requires `siteUrl`; falls back to the Collection's `realtimeState` if the LRO record has aged out.
- `DELETE /api/destination/sharepoint-connector?session=&siteUrl=` **(new)** — clears our tracking row only, never the real Google-side resource.
- `GET /api/destination/connectors?session=` **(new)** — lists every configured connector for the customer.

### `migrate.ts`
- `POST /api/migrate/plan` — dropped the `knowledgeHandling` body field (that chooser is gone, §9).
- `POST /api/migrate/knowledge-candidates` **(new)** — `{session, envUrl, filename, modifiedByUserId?, sharePointSiteIds?}` → Graph search candidates only (never migrates).
- `POST /api/migrate/knowledge-source-resolve-url` **(new)** — resolves a Copilot Studio "Knowledge URL" via `resolveShareUrlSmart` (folder-aware: `'file'|'folder-single-file'|'folder-multiple-files'|'not-found'`).
- `POST /api/migrate/knowledge-source-confirm` **(new)** — `{session, agentId, driveId, itemId, name, dryRun?, project?, engine?, assistant?}`. Downloads the confirmed drive item and attaches it via the same `agentFiles` mechanism as local uploads. Error: `knowledge_source_confirm_failed` (502).

Standard error shape unchanged: `res.status(code).json({ error: 'snake_case_code', detail? })`.

---

## 5. Frontend

React 18 + Vite 6 + `react-router-dom` 6. Wizard: Connect → Choose Pair → Select & Map → **Connectors (new)** → Select Data → Migrate → Report.

- **`web/src/pages/Connectors.tsx`** (new) — cross-environment batch view: scans every accessible environment via `fetchConnectorsNeeded`, lists every distinct SharePoint/OneDrive site referenced by any agent plus which agents reference it, and renders inline setup per SharePoint site. OneDrive shows a "not built yet" warning (backend `setUpOneDriveConnector()` deliberately throws — see §6).
- **`web/src/components/ConnectorSetup.tsx`** (new — first file in the new `components/` dir) — reusable panel: shows connector status (`checking|pending|done|failed`), pre-fills Tenant ID from the session's Microsoft connection, lets the admin optionally supply Client ID/Secret (blank = reuse stored credential), offers "Remove & set up again." Used from both `Explore.tsx` and `Connectors.tsx`.
- `api.ts` — removed `KnowledgeHandling` type; added `removeSharePointConnector`, `fetchKnowledgeConnectors`, `fetchConnectorsNeeded`, `findKnowledgeCandidates`, `confirmKnowledgeSource`; `planMigration()` no longer takes a `knowledgeHandling` arg.
- `Explore.tsx` — dropped the owned/3rd-party ownership tag from `KnowledgePanel`; added inline `<ConnectorSetup>` for `sharepoint-connector` actions.
- `SelectMap.tsx` — added links to `/connectors` and `/explore`.
- **`Migrate.tsx` — possible UI regression to confirm**: the expandable per-fidelity-item `<details>` breakdown was dropped from `AgentCard`; only summary count chips (auto/adapt/needs-review) remain. The full detail still exists in the backend `MigrationResult.fidelity` and the markdown report — it's just not surfaced on this screen anymore. Flag this with whoever made the change: intentional simplification, or an accidental loss of the honesty-principle detail the report is supposed to show?

---

## 6. New feature: SharePoint/OneDrive knowledge-connector integration

The largest chunk of uncommitted work. Lets a migrated agent's SharePoint/OneDrive knowledge sources actually resolve, instead of being dropped or turned into text filler.

**New services:**
- `services/geminiConnector.ts` — `setUpSharePointConnector()`, `getConnectorOperation()`, `getConnectorDataStores()` talk to Google Discovery Engine `v1alpha`'s `setUpDataConnector` (creates a federated SharePoint connector + Collection), polls the operation, and reads the Collection back to discover auto-created data-store ids. `setUpOneDriveConnector()` **throws** — deliberately unimplemented; OneDrive's `dataSource` wire value isn't yet verified against Google's docs.
- `services/graphFiles.ts` — `encodeShareId`, `resolveShareUrl`, `resolveShareUrlSmart`, `downloadDriveItemBytes` — Microsoft Graph `v1.0`, reusing the existing app-only Dataverse token (no new auth surface).
- `services/graphSearch.ts` — `searchOneDriveForFile`, `searchSharePointSiteForFile`, `findCandidates` (deduped, capped at 10 results). Deliberately narrow-scoped — never a tenant-wide search.
- `services/secretManager.ts` — `putEntraSecret`/`getEntraSecret` against GCP Secret Manager REST, using the existing `cloud-platform` SA scope (no new npm dependency). Per-tenant Entra client secrets are stored under **CloudFuze's own** GCP project (new env var `CLOUDFUZE_GCP_PROJECT`), never a customer's project, never Mongo — see the 2026-08-03 decision in `.claude/memory/decisions.md`.

**Orchestrator integration** (`orchestrator.ts`):
- SharePoint native-connector reconnect: looks up the per-site `knowledgeConnectors` row, polls, discovers data-store ids, attaches via `attachDataStoreToEngine`. Correctly reports the **engine-wide visibility caveat** as `FidelityNote.status: 'partial'` — attaching a data store to an engine makes it visible to *every* agent sharing that engine, not just the one that referenced it in Copilot Studio.
- Search-assisted resolution for "upload and sync" (`FederatedStructuredSearchSource`) sources with no discoverable URL: calls `findCandidates`, auto-attaches only when there's exactly one plausible-name-match candidate, otherwise stores candidates on `MigrationResult.knowledgeSourceCandidates` for human confirmation via `POST /api/migrate/knowledge-source-confirm`.
- `attachKnowledgeFiles()` now returns structured `failures: {name, reason}[]` with `cleanUploadFailureReason()` turning raw Google errors (e.g. `MODEL_ARMOR_VIOLATION`) into an honest customer-facing sentence — every failure becomes a `FidelityNote`, never just a log line.
- **Draft preservation**: if the source Copilot agent was never published (`!sourceMetadata.lastPublished`), the migrated Gemini agent is left as Draft (`result.deployed = false; result.draftPreserved = true`) instead of force-publishing everything.
- SA-auth order flipped: **DWD impersonation of the connected admin is now tried first**, falling back to direct IAM (previously direct IAM was tried first) — so an SA-owned agent isn't orphaned from any customer identity if the SA's direct IAM grant is later revoked.

**Known open item**: revocation/rotation UX for stored Entra secrets (what happens when a customer rotates their secret, or wants CloudFuze's stored copy deleted) is explicitly **not yet designed** — flagged in the decision log as a follow-up required before a real customer uses this path.

---

## 7. Git state — what is and isn't committed

`business` branch has exactly **2 commits**:
1. `a183a29` — Initial commit
2. `ee9b9c0` — "Add multi-account Gemini support, DWD impersonation allowlist, and Dataverse table export"

On top of that is a **large uncommitted working tree** — this is where most of §6 (the connector feature) lives, plus:
- A pure rename: all `server/src/_diag_*.ts` / `_test_*.ts` / etc. spike files moved into `server/src/spikes/` (confirmed no logic change beyond import-path fixes, per project convention). One file, `_test_appendix.ts`, was renamed then deleted (it tested `buildKnowledgeReferencesAppendix()`, which was removed — see §9).
- **69 new untracked spike files** under `server/src/spikes/` — live probes for ADK/website-grounding, SharePoint/Graph connectors, agent-file upload/deployment-decay, session/IAM/knowledge-content debugging. Throwaway by convention, not app code.
- Modified: `types.ts` (both server and web), all the routes/services listed above, `orchestrator.ts`, `config.ts`, `db/mongo.ts`, `sessionStore.ts`, several `.claude/` memory/rule files, `docs/knowledge-sources-migration-playbook.md`, `docs/ONBOARDING_AND_LICENSING.md`, `server/scripts/adk_deploy.py`.

**Typecheck status: clean.** Both `cd server && npm run typecheck` and `cd web && npm run typecheck` pass with zero errors on the current working tree.

**Before merging, be aware of:**
- **Untracked non-code artifacts not yet `.gitignore`d**: `discovery_v1alpha.json` (2.2 MB Google API discovery dump), `server/adk_local_test/` (contains `__pycache__/*.pyc` and a SQLite `.adk/session.db` from local ADK CLI testing), `docs/CAPABILITIES-AND-RESEARCH-REPORT-2026-07-30.docx`. A careless `git add -A` on either side of the merge would stage all three.
- **`CLOUDFUZE_GCP_PROJECT` (new env var) is missing from `server/.env.example`** — a teammate pulling this branch won't know it exists. `GOOGLE_DWD_ALLOWED_IMPERSONATORS` (also new) *is* documented there.
- **`CLAUDE.local.md` is stale**: it references `GOOGLE_AUTH_MODE=bypass` / `GOOGLE_IMPERSONATE_EMAIL`, both removed from `config.ts` in `ee9b9c0`. Local Google dev now requires real OAuth every time.

---

## 8. ADK deployment path — still gated off

`services/adkDeployer.ts`'s `needsAdkDeployment()` is hard-coded to `return false` ("TEMPORARILY DISABLED — Business-edition-only testing phase"), because the Standard/Plus edition differentiation that used to trigger ADK for gallery visibility was removed from `GeminiDestination`/`Session`. Real, typechecked code exists but is **unreachable**:
- `hasWebsiteKnowledgeSource`, `firstWebsiteSource`, `createWebsiteGroundingDataStore` (a BASIC-tier `PUBLIC_WEBSITE` data store for ADK's `VertexAiSearchTool`).
- `buildAdkSpec`/`publishAgentToGallery` accept a `vertexAiSearchDataStore`.
- `server/scripts/adk_deploy.py` wires `VertexAiSearchTool` as the agent's *only* tool when that field is set (ADK pre-1.16 rejects mixing it with `google_search`).

Per `.claude/memory/decisions.md` (2026-08-02), **re-enabling ADK is the recommended next engineering step** for the "migrated agent stays PRIVATE forever" gap — A2A and Dialogflow CX were evaluated and rejected. Two things to reconcile before flipping the gate back on:
1. A **higher-priority, independent risk**: verify `lowCodeAgentDefinition` (the current default create path) still exists in Google's live `v1alpha` discovery document — it no longer appears there per the decision log.
2. A **minor inconsistency**: the orchestrator's dead ADK branch sets `deployed = true; shared = true` unconditionally with a code comment claiming this is confirmed-correct live behavior (2026-07-31), while the decision log still lists the same behavior as an open gap needing a draft-mirroring check. Since the branch is unreachable either way, this costs nothing today — but resolve the discrepancy before re-enabling.

---

## 9. Removed: website knowledge-source special-casing

As of the 2026-07-30 decision, all "public website" handling was removed: `knowledgeClassifier.ts`'s `websiteOwnership()` heuristic and the website-recreate rule, `knowledgePlanner.ts`'s website-folding action, `mapper.ts`'s `buildKnowledgeReferencesAppendix()` and `unsupportedKnowledgeHandling` option, and the `knowledgeHandling` field threaded through `types.ts` → `orchestrator.ts` → `routes/migrate.ts` → `web/api.ts` → `Migrate.tsx`. A website source now falls through to a plain `manual-review` classification — the URL is still preserved losslessly on `AgentIR` and surfaced in the report, but nothing is auto-created or pasted into instructions. Reason: Gemini Enterprise apps can't attach a website data store at all, so the old appendix path was pasting raw URLs into instruction text, not real grounding.

**Side effect**: `services/organizationProfile.ts` is now orphaned dead code — it still runs once per migration (2 API calls) purely to log a result nobody consumes. Kept intentionally per the decision log, not an oversight — a future feature might want org-domain discovery again.

---

## 10. Known limitations (pre-existing, still true)

- No formal test runner — testing is `_test_*`/`_diag_*` tsx spikes + in-pipeline `verify.ts` + gstack `/qa`. A `vitest` suite for the pure transforms (`mapper`, `topicCompiler`, `knowledgeClassifier`, `scope`) is the recommended next step.
- Flows/workflows are not migrated — Phase 1 is agents only.
- Gemini edition/visibility gap: migrated agents list in Business edition but not Standard/Plus (governed gallery) — documented platform behavior, not a bug.
- Discovery Engine write quota is the real throughput ceiling — mitigated by low insert concurrency + backoff; large tenants may need staged runs.
- **New, serious**: `docs/SUPPORT-TICKET-AGENT-FILE-DEPLOYMENT-DECAY.md` documents a live-reproduced Google-side bug where a low-code agent's `deployedNodes` either never materializes after a successful `:publish`, or spontaneously disappears from a previously-working agent with zero edits — an agent can silently stop answering anything, hours to days after a successful migration, for reasons outside CloudFuze's control. Worth reading before promising customers post-migration stability on the default (low-code) path.

---

## 11. Merge checklist

- [ ] Reconcile `Migrate.tsx`'s dropped per-fidelity `<details>` list (§5) with whoever wrote it.
- [ ] Add `CLOUDFUZE_GCP_PROJECT` to `server/.env.example` (§7).
- [ ] Add `discovery_v1alpha.json`, `server/adk_local_test/`, and the stray `.docx` to `.gitignore`, or intentionally commit them if they're meant to be reference material (§7).
- [ ] Update `CLAUDE.local.md` guidance on Google auth bypass — it's dead (§7).
- [ ] Decide the commit shape for the uncommitted diff: it's one pipeline concern (SharePoint/OneDrive connector feature) plus incidental cleanup (spike rename, website-handling removal) — per `.claude/rules/pr-standard.md`, consider whether the spike-rename and website-removal should be their own commit(s) separate from the connector feature.
- [ ] Both `server` and `web` typecheck clean as of this snapshot — re-run after merge to confirm the merge didn't reintroduce errors.
- [ ] Resolve the ADK honesty-gap discrepancy (§8) before any future work re-enables `needsAdkDeployment`.
