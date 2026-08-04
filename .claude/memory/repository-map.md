# Memory: Repository Map

File-by-file guide so Claude can navigate without scanning. Read this before grepping the tree.

## Root

| Path | What |
|------|------|
| `README.md` | Short public overview: stage table, layout, quick start |
| `copilot-to-gemini-component-mapping.md` | The big source→target component mapping reference |
| `service_account.json` | **SECRET, git-ignored** — Google SA key. Never read/commit |
| `.env` (in `server/`) | **SECRET, git-ignored** — runtime config |
| `docs/` | Specs, feasibility, findings, support tickets (see below) |
| `.claude/` | This knowledge base (rules, commands, skills, agents, hooks, memory, workflows) |
| `CLAUDE.md` | Session entry point + gstack prerequisites/routing |

## `server/` — Node + TypeScript + Express API

### Entry & config
| File | Role |
|------|------|
| `src/server.ts` | App bootstrap: CORS, JSON, mounts routers, connects Mongo, listens :8080 |
| `src/config.ts` | Zod-validated env config (fail-fast) + OAuth scope constants |
| `src/logger.ts` | Pino logger (pretty in dev) |
| `src/sessionStore.ts` | Session helpers (`getSession`, `createSession`, ids, `DEFAULT_APP_USER_ID`) |
| `src/orchestrator.ts` | **The engine** — two-phase EXTRACT/INSERT, `EventQueue`, `mapPool`, `runMigration` |
| `src/types.ts` | **Start here** — `AgentIR`, `TopicIR`, `MigrationResult`, `ProgressEvent`, scopes, plans |

### Routes (`src/routes/`) — mounted `/api/<name>`
| File | Endpoints |
|------|-----------|
| `auth.ts` | Microsoft/Google connect, session, resume, disconnect; SA reachability checks |
| `explore.ts` | Discover environments/agents (inventory) |
| `destination.ts` | Gemini destination resolution / mapping options |
| `migrate.ts` | `POST /plan` (scope→plan) + `GET /stream` (SSE run) + report |

### Services (`src/services/`) — domain logic
| File | Role |
|------|------|
| `dataverse.ts`, `dataverseSnapshot.ts` | **Extract** from Dataverse → `AgentIR` |
| `mapper.ts` | **Map** `AgentIR` → Gemini definition + instruction synthesis |
| `gemini.ts` | **Create/publish/share** via Discovery Engine + quota backoff; destination discovery |
| `geminiAgentFiles.ts`, `geminiDataStore.ts` | Knowledge file upload/attach; data stores |
| `adkDeployer.ts` | ADK reasoning-engine deploy path |
| `verify.ts` | **Verify** migrated agents (smoke test) |
| `report.ts` | **Report** — per-agent fidelity |
| `scope.ts` | Resolve a `MigrationScope` → flat work-list |
| `assess.ts`, `destination.ts` | Pre-flight assessment; destination options |
| `organizationProfile.ts` | Discover org facts (domains, envs, project) once |
| `knowledgeClassifier.ts`, `knowledgePlanner.ts` | Classify + plan knowledge-source migration |
| `topicCompiler.ts`, `topicGraph.ts`, `topicsEmit.ts`, `topicsMigration.ts` | Topics → behavior graph → emit |
| `stateThreading.ts`, `importReconcile.ts` | Conversation state; import reconciliation |
| `quota.ts`, `rateLimiter.ts` | Quota preflight + rate limiting/backoff |

### DB (`src/db/`)
| File | Role |
|------|------|
| `core.ts` | Cached `MongoClient` factory (`connectDb`/`getDb`/`isDbConnected`) |
| `mongo.ts` | Bootstrap: ensures all **9 collections + indexes** on startup; seeds default users |
| `repos/migrations.ts` | `migrationRuns`/`migrationResults`/`migrationLogs` writes (best-effort) |
| `repos/staged.ts` | `stagedAgents` staging area (Phase 1 → Phase 2 handoff) |
| `repos/agentIR.ts` | `agentIRCache` (extracted IR + mapped agent) |
| `repos/environments.ts` | `environmentsCache` (discovered inventory) |
| `repos/users.ts` | `appUsers` (login accounts) |

### Auth (`src/auth/`)
| File | Role |
|------|------|
| `microsoft.ts` | Graph/Dataverse tokens (app-only `client_credentials` for extraction) |
| `google.ts` | Service account tokens (Direct IAM / DWD impersonation), SA config checks |

### Scripts & spikes
| Path | Role |
|------|------|
| `scripts/adk_deploy.py` | Python ADK agent deploy helper (top-level `server/scripts/`, unrelated to `src/spikes/`) |
| `src/spikes/_diag_*.ts`, `_test_*.ts`, `_demo_*.ts`, `_poc_*.ts`, `_probe_*.ts`, `_spike_*.ts` | **Throwaway** diagnostic/integration spikes run via `tsx`, all collected under `server/src/spikes/`. NOT app code — exempt from rules |

## `web/` — React + Vite front-end

| Path | Role |
|------|------|
| `src/main.tsx`, `src/App.tsx` | Bootstrap; router + wizard `STEPS` stepper + header |
| `src/api.ts` | Typed fetch wrappers; OAuth popup + `postMessage` helper |
| `src/types.ts` | Web-side view types |
| `src/pages/` | `Landing`, `Login`, `Home`, `Connect`, `ChoosePair`, `Explore`, `SelectMap`, `SelectData`, `Migrate` |
| `src/styles.css`, `src/icons.tsx` | Hand-rolled CSS (no UI lib); inline icons |
| `vite.config.ts` | Vite config (dev proxy to `:8080`) |

## `docs/` — knowledge base

| File | Role |
|------|------|
| `AGENTIR_V2_SPEC.md` | The `AgentIR` specification (the contract) |
| `architecture/topics-migration-production.md` | Production topics-migration design |
| `MIGRATION-V1.md`, `knowledge-sources-migration-playbook.md` | Stage playbooks |
| `GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`, `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`, `LIMITATIONS-EDITING-AGENTS.md` | Findings on real Gemini behavior/limits |
| `SUPPORT-TICKET-*.md` | Filed tickets: quota, visibility, editing deployed agents |
| `ONBOARDING_AND_LICENSING.md` | Customer onboarding / licensing |
| `Migration-Feasibility*.docx` | Feasibility studies (binary) |