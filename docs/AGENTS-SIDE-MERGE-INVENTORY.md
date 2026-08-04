# Agents-side merge inventory

**Purpose:** you're working the **agents** side (Copilot Studio → Gemini Enterprise, Phase 1), your teammate is working the **workflows/flows** side (the later phase per `CLAUDE.md` — not built yet). This doc is the exact, mechanical list of what you've added/changed/renamed, organized by merge-conflict risk, so that when their branch shows up, neither of you overwrites the other's work and nothing gets silently dropped.

For the *narrative* (what each feature does, why) see [CURRENT-STATE-FOR-MERGE.md](CURRENT-STATE-FOR-MERGE.md). This doc is purely "what touched what."

**Snapshot date:** 2026-08-03. Regenerate the file lists below (`git diff --name-status`, `git ls-files --others --exclude-standard`) right before the actual merge — this is a point-in-time inventory, not a live one.

---

## 0. Do this before any merge happens

Everything below is currently **uncommitted** in your working tree. Uncommitted changes are not protected by git — a `git checkout`, `git merge`, or `git pull` that touches a file you've modified can silently overwrite or lose it. Before your teammate's branch enters the picture:

1. `git add` the files you intend to keep (use the lists below — do **not** use `git add -A`, three untracked artifacts in §4 should not be committed as-is).
2. Commit in logically separate chunks per `.claude/rules/pr-standard.md` ("keep PRs to one pipeline concern") — at minimum: (a) the spike-file rename, (b) the SharePoint/OneDrive connector feature, (c) the website-handling removal, as separate commits, not one giant one.
3. Push `business` so the committed state is recoverable.

Only after that is your side "safe" for a merge to land on top of.

---

## 1. Brand-new files — zero conflict risk

Git can't conflict on a file that only one side created, *unless* your teammate independently creates a file at the exact same path. Nobody else should be writing to these paths:

**Server:**
```
server/src/services/geminiConnector.ts
server/src/services/graphFiles.ts
server/src/services/graphSearch.ts
server/src/services/secretManager.ts
server/src/db/repos/adkDeployments.ts
server/src/db/repos/entraAppCredentials.ts
server/src/db/repos/knowledgeConnectors.ts
```

**Web:**
```
web/src/pages/Connectors.tsx
web/src/components/ConnectorSetup.tsx      (also: web/src/components/ is a brand-new directory)
```

**Docs:**
```
docs/SUPPORT-TICKET-AGENT-FILE-DEPLOYMENT-DECAY.md
docs/CURRENT-STATE-FOR-MERGE.md
docs/AGENTS-SIDE-MERGE-INVENTORY.md   (this file)
```

Plus **69 new spike files** under `server/src/spikes/_diag_*.ts` / `_test_*.ts` — throwaway probes, listed in full in [CURRENT-STATE-FOR-MERGE.md §11](CURRENT-STATE-FOR-MERGE.md#7-git-state--what-is-and-isnt-committed). Not app code; irrelevant to conflict risk since flows work won't touch this directory.

---

## 2. Modified existing files — real conflict risk

These files existed before your changes. If your teammate's workflows branch *also* touches any of these, git will need a real 3-way merge (or you by hand). Ranked by how likely a flows feature is to also need to touch them:

### High risk — shared "spine" files a flows feature would plausibly also extend
| File | What you changed | Why a flows change might collide here |
|---|---|---|
| `server/src/types.ts` | Added `KnowledgeSourceMetadata.modifiedByUserId`, `MigrationResult.draftPreserved`/`knowledgeSourceCandidates`, removed `ResolvedPlan.knowledgeHandling` | This is the shared `AgentIR`/`MigrationResult`/`ProgressEvent` contract file — a flows feature will almost certainly add its own types here too |
| `server/src/orchestrator.ts` | SharePoint reconnect block, search-assisted resolution, draft-preservation logic, SA-auth order flip, `attachKnowledgeFiles()` reshape | The two-phase engine — a flows insert step would likely add a new branch inside the same file |
| `server/src/config.ts` | Added `CLOUDFUZE_GCP_PROJECT`; removed `GOOGLE_AUTH_MODE`/`GOOGLE_IMPERSONATE_EMAIL` | Zod schema is one object — any new flows env var edits the same file |
| `server/src/db/mongo.ts` | Added 3 new collections/indexes (12 total now, was 9) | Same bootstrap function — a flows collection add is the same shape of edit, same file |
| `server/src/routes/migrate.ts` | Dropped `knowledgeHandling` param, added 3 new endpoints | If flows execution also streams through `/api/migrate/stream` or needs its own plan/run endpoints, this is the collision point |
| `server/src/sessionStore.ts` | Modified (session shape) | Shared session helpers |
| `web/src/App.tsx` | Added `/connectors` route + step label | Shared router/wizard-step list — a flows step insertion touches the same array |
| `web/src/api.ts` | Removed `KnowledgeHandling`, added 5 new fetch wrappers | Shared typed-fetch file |
| `web/src/types.ts` | Removed `KnowledgeAction.ownership`, added `references?` | Shared web-side view types |

### Medium/low risk — agents-pipeline-specific, unlikely to overlap with flows
```
server/src/db/repos/staged.ts
server/src/routes/destination.ts
server/src/routes/explore.ts
server/src/services/adkDeployer.ts
server/src/services/assess.ts
server/src/services/dataverse.ts
server/src/services/gemini.ts
server/src/services/geminiConnector.ts
server/src/services/geminiDataStore.ts
server/src/services/knowledgeClassifier.ts
server/src/services/knowledgeDataStoreExecutor.ts
server/src/services/knowledgePlanner.ts
server/src/services/mapper.ts
server/src/services/report.ts
server/scripts/adk_deploy.py
web/src/pages/Explore.tsx
web/src/pages/Home.tsx
web/src/pages/Migrate.tsx
web/src/pages/SelectMap.tsx
```

### `.claude/` knowledge-base files (not app code, but still text-mergeable)
```
.claude/agents/test-writer.md
.claude/memory/decisions.md
.claude/memory/progress.md
.claude/memory/repository-map.md
.claude/rules/code-style.md
.claude/rules/testing-standard.md
.claude/settings.json
.claude/skills/testing-patterns/SKILL.md
.claude/workflows/testing.md
CLAUDE.md
docs/ONBOARDING_AND_LICENSING.md
docs/design/multi-account-gemini.md
docs/knowledge-sources-migration-playbook.md
```
If your teammate is also updating `.claude/memory/*` or `CLAUDE.md` as they build the flows phase, expect conflicts here — these are prose files, so resolve by combining both sides' additions rather than picking one (neither of you should silently drop the other's entries in `decisions.md`/`progress.md`, since those are append-oriented logs).

---

## 3. Renamed files — path changed, low risk unless teammate has local edits

All `server/src/_diag_*.ts` / `_test_*.ts` / `_demo_*.ts` / `_poc_*.ts` / `_probe_*.ts` / `_spike_*.ts` / `_dump_*.ts` / `_prep_*.ts` / `_register_*.ts` / `_del_*.ts` files moved from `server/src/` into `server/src/spikes/` (pure move — import paths fixed, no logic change; confirmed by spot-check). Full list is the "R100" renames in `git diff --cached --name-status`.

**Only risk**: if your teammate's local branch was forked *before* this rename and they independently modified one of these files at its *old* path (e.g. `server/src/_diag_agent.ts`), git's rename detection usually still merges cleanly (it tracks content similarity, not just path), but a manual conflict is possible if they made a large edit. Ask them: "did you touch any `_diag_*`/`_test_*` file directly under `server/src/` (not `server/src/spikes/`)?" If yes, expect a rename conflict on that one file.

One file was renamed then deleted: `server/src/_test_appendix.ts` no longer exists anywhere (it tested code that was removed — see CURRENT-STATE-FOR-MERGE.md §9). If your teammate has local edits to this specific file, they'll need to know it's intentionally gone, not a bad merge.

---

## 4. Untracked files that should NOT be committed as-is

These exist in your working tree but aren't `.gitignore`d yet. Don't `git add -A` — you'd ship a 2.2MB reference dump and Python bytecode:
```
discovery_v1alpha.json                          (Google API discovery reference dump)
server/adk_local_test/                          (contains __pycache__/*.pyc and a SQLite session.db from local testing)
docs/CAPABILITIES-AND-RESEARCH-REPORT-2026-07-30.docx
.claude/launch.json                             (harmless, but confirm before committing — VS Code debug config)
```
Add the first three to `.gitignore` before committing, or explicitly decide they're reference material worth keeping tracked.

---

## 5. Reserved namespaces — don't reuse these names for flows work

So your teammate doesn't accidentally pick a colliding name for their own feature:

**Mongo collections** (12 total; these 3 are new): `entraAppCredentials`, `knowledgeConnectors`, `adkDeployments`

**New API routes:**
```
DELETE /api/destination/sharepoint-connector
GET    /api/destination/connectors
GET    /api/explore/connectors-needed
POST   /api/migrate/knowledge-candidates
POST   /api/migrate/knowledge-source-resolve-url
POST   /api/migrate/knowledge-source-confirm
```

**New env vars:** `CLOUDFUZE_GCP_PROJECT`, `GOOGLE_DWD_ALLOWED_IMPERSONATORS`

**New error codes:** `connectors_needed_failed`, `site_url_and_tenant_id_required`, `connector_credentials_required`, `connector_setup_failed`, `connector_not_configured`, `connector_status_failed`, `site_url_required`, `knowledge_source_confirm_failed`

**Removed (don't resurrect without checking why they were removed):** `GOOGLE_AUTH_MODE`, `GOOGLE_IMPERSONATE_EMAIL` env vars; `ResolvedPlan.knowledgeHandling` / `KnowledgeAction.ownership` / `KnowledgeHandling` type; `services/organizationProfile.ts`'s consumers (the service itself still runs, but nothing reads its output anymore).

---

## 6. Recommended merge sequence

1. Commit your agent-side work per §0 (separate commits for rename / connector feature / website-removal cleanup).
2. When the workflows branch is pushed, `git fetch` it and read *their* diff the same way this doc reads yours — ask your teammate to run the same `git diff --name-status` / `git ls-files --others --exclude-standard` and compare against §2's "High risk" table above before attempting the merge.
3. Merge (not rebase) if both branches have meaningful history you both want preserved; rebase only if one of you is comfortable rewriting your own branch's history — never rebase a branch the other person has already pulled from.
4. After the merge, re-run `npm run typecheck` in both `server/` and `web/` (it was clean on this side as of this snapshot) and re-run `GET /api/health` + a `/qa` pass — a clean merge at the text level doesn't guarantee the two features still work together at runtime (e.g. if flows also touches `orchestrator.ts`'s phase loop).
5. Manually reconcile `.claude/memory/decisions.md` and `progress.md` (§2) by hand — these are append-only logs; take both sides' entries, don't let git pick one.
