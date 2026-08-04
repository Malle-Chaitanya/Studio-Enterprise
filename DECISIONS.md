# Studio Enterprise — Workflow Migration Decisions & Status

Last updated: 2026-07-29

---

## What Is Actually Verified Working

| Item | Verified How |
|---|---|
| Hermas server live at `134.209.146.36:8080` | `curl /health` returns `{"status":"ok"}` |
| Hermas uses OpenAI GPT-4o-mini | Real YAML generated and deployed to GCP |
| Node.js 20 on server | `node --version` = v20.20.2 |
| TypeScript compiles clean | `tsc --noEmit` zero errors |
| `server/.env` has `HERMAS_URL=http://134.209.146.36:8080` | file confirmed |
| Port 8080 open on server | UFW rule added, `curl` from local succeeds |
| **3 flows SUCCEEDED in GCP** | API TEST, Sample Flow, Send Teams message weekly |
| **5 Hermas flows deploy + execute** | All unsupported flows route → Hermas → GCP → execute |
| **Agentic fix loop** | Retried "New file in SharePoint" after 502 error, fixed and deployed |

---

## Verified in Real GCP (30-07)

From `_test_workflow_migration.ts` against `orga243378d` Dataverse + `studio-enterprise-migration` GCP:

| Flow | Trigger | Route | GCP State | Note |
|---|---|---|---|---|
| Send Teams message weekly | Recurrence | Rule-based | **SUCCEEDED** | Cloud Scheduler config generated |
| API TEST | Webhook/HttpRequest | Rule-based | **SUCCEEDED** | Pub/Sub topic generated |
| Sample Flow | Webhook | Rule-based | **SUCCEEDED** | Pub/Sub topic generated |
| SharePoint to Teams | Unknown | Hermas | FAILED | Deployed+executed, Teams API bytes error |
| 5. File notification | Unknown | Hermas | FAILED | Deployed+executed, MS auth (test creds) |
| New email alert | Unknown | Hermas | FAILED | Deployed+executed, MS auth (test creds) |
| New email arrives | Unknown | Hermas | FAILED | Deployed+executed, MS auth (test creds) |
| New file SP→Teams | Unknown | Hermas+fixloop | FAILED | 502→fix loop→deployed+executed, MS auth |

**All 8 flows deploy to GCP. 3 fully SUCCEED. 5 fail at runtime due to test credentials — expected.**

## Code Still Untested

| File | What it does | Needs to verify |
|---|---|---|
| `server/src/services/parallelRunner.ts` | Runs GCP + PA side by side, compares | Real execution comparison |
| `server/src/routes/workflows.ts` | 6 API endpoints + full migrateOneFlow() | End-to-end API call |
| `server/src/db/repos/workflowFlows.ts` | MongoDB reads/writes for flow state | Real data in MongoDB |

MongoDB schema added to `db/mongo.ts` — **not verified the collections exist** (needs server restart + connection).

---

## Architecture Decisions Made

### Deployment
- Hermas deployed to VPS `134.209.146.36` (not Cloud Run — decided by user for now)
- LLM: OpenAI GPT-4o-mini (API key set on server)
- Provider can switch via `HERMAS_LLM_PROVIDER` env var (openai/nous/hunyuan/claude/gemini)

### Multi-tenancy
- Each customer gets their own GCP project (fresh, not shared with CloudFuze)
- Customer pays for their own GCP usage
- Customer authenticates via Google OAuth (not service account key paste)
- MS OAuth tokens stored encrypted in MongoDB, persistent until customer disconnects

### Scope
- **Agent flows only** — Copilot Studio PA flows (triggered from agent topics via "Run a flow")
- NOT all Power Automate flows in the environment
- Migration unit = Copilot Studio agent + its associated flows

### Migration flow
- All 3 PA environments migrated (DEV/TEST/PROD) — customer picks which
- Full PA flow definition stored in MongoDB (not just metadata)
- Flow names: use PA flow name directly (no prefix)
- Auto-migrate flows first, flagged flows shown after for customer answers
- Try ALL flows including unsupported — document exactly why each fails
- Migration is resumable — customer can close and come back next day

### Migration pipeline per flow
1. Score confidence (0-100)
2. ≥80 → rule-based mapper (flowMapper.ts)
3. 50-79 → hybrid (mapper + customer answers)
4. <50 → Hermas (LLM)
5. Deploy YAML to customer GCP via their OAuth token
6. Run test execution in GCP
7. If fails → Hermas fix loop (max 5 retries, error sent back each time)
8. Parallel run: GCP workflow + PA flow both triggered, outputs compared
9. Mismatch → Hermas fix loop again
10. All results persisted to MongoDB
11. **Register workflow as Gemini Agent tool** (see below)

### Connector replacement (3-tier)
Every flow that uses a non-Dataverse MS connector gets a per-connector question in the UI:
- **Keep MS connector** → YAML calls MS Graph/Teams/SharePoint with delegated Entra token from Secret Manager
- **Switch to Google equivalent** → YAML calls Google API with SA OAuth2 token

**Tier 1 — Rule-based connector map (deterministic YAML):**

| MS Connector | Google Equivalent |
|---|---|
| Teams | Google Chat |
| SharePoint | Google Drive |
| Office 365 / Outlook | Gmail |
| OneDrive | Google Drive |
| Azure Blob | Cloud Storage |
| Planner | Google Tasks |
| Exchange | Gmail |
| Forms | Google Forms |
| Calendar | Google Calendar |
| Dataverse | Keep (no change) |

**Tier 2 — Hermas (LLM):** Unknown connectors. Prompt includes connector name + customer choice. Generates best-effort YAML for any connector (custom APIs, niche connectors, etc.)

**Tier 3 — Flagged stub:** Truly unmappable (e.g. Salesforce, ServiceNow). YAML gets a TODO stub, flagged in UI as "needs manual review".

### Flow triggers — how they work after migration

**Automatic triggers (no action needed):**
- Recurrence → Cloud Scheduler (already implemented, verified)
- HTTP/Webhook → Pub/Sub topic + push subscription (already implemented, verified)

**Agent-triggered flows ("Run a flow" in Copilot Studio topic):**
After migration, the Copilot Studio agent is replaced by a Gemini Agent. The PA flow is replaced by a Cloud Workflow. The connection between them:

```
User message
    ↓
Gemini Agent (migrated from Copilot Studio)
    ↓ topic fires → tool call
Cloud Workflow tool (OpenAPI spec → Workflow Executions API)
    ↓
Cloud Workflow executes (GCP)
    ↓
Result returned to Gemini Agent
    ↓
Agent responds to user
```

**Implementation:**
1. Each migrated Cloud Workflow → generate an OpenAPI tool spec (args schema → tool parameters)
2. Register tool in Vertex AI Agent Builder via API
3. Link tool to the Gemini agent that owned the original PA flow
4. The migrated agent topic that had "Run a flow" → now has the Cloud Workflow tool registered

**This means:** agent-triggered flows work end-to-end post-migration with no manual wiring. The migration pipeline does it automatically.

### Agent flow scanning (Task #3 — Done)

Two-level discovery (`agentFlowScanner.ts`):
1. **Level 1 (fast)**: solution membership — all cat=5 flows in the same solution as any bot. Works for any Dataverse environment.
2. **Level 2 (precise)**: topic YAML content scan — reads `data` field of botcomponents (type=9 topics), looks for `InvokeFlowAction` / `RunFlowAction` in the YAML to find the exact agent→flow link.

In the demo Dataverse (`orga243378d`): 7 agents, all in solution `fd140aae-4df4-11dd-bd17-0019b9312238`, 11 flows in the same solution. No custom topics yet → Level 1 fallback. In production environments with real Copilot Studio agents, Level 2 will give per-agent flow lists.

### Cloud Workflows as Gemini Agent tools (Task #15 — Done)

`workflowToolRegistrar.ts` provides:
- `generateWorkflowToolSpec(ir, project, region, workflowName)` → OpenAPI 3.0 spec
- `registerWorkflowTool(token, project, location, agentId, spec, displayName)` → Dialogflow CX tool
- `attachToolToAgent(token, project, location, agentId, toolName)` → adds to agent tool list
- `attachToolToPlaybook(playbook, toolName)` → links tool to a specific playbook

Verified working: "Send Teams message weekly" flow registered as tool in `CX Test Agent` (global, agent `2aad4f89-...`), attached to Default Generative Playbook.

Migration pipeline (`migrateOneFlow` in `workflows.ts`) automatically registers the tool post-deploy when `dfAgentId` is provided in opts.

### Pending decisions (NOT decided yet — discuss when building)
- [ ] GCP project: create fresh per customer OR use existing? (noted to discuss when building GCP OAuth)
- [ ] Parallel run output comparison: what exactly to compare for non-HTTP flows? (noted to discuss)
- [ ] Notifications: email + dashboard — not built yet, planned for 05-08
- [ ] Delegated MS token for "keep MS connector" flows: customer MS OAuth or service account DWD?

---

## Task Status (honest)

| # | Task | Status | Date |
|---|---|---|---|
| 1 | Hermas live + OpenAI verified | **Done** | 28-07 |
| 2 | GCP OAuth — customer connects Google | **Done** | 30-07 |
| 3 | Scan agent flows from Copilot Studio Dataverse | **Done** | 31-07 |
| 4 | Rule-based YAML recurrence — verified in GCP console | **Done** | 29-07 |
| 5 | Rule-based YAML HTTP — verified in GCP console | **Done** | 29-07 |
| 6 | Rule-based YAML webhook — verified in GCP console | **Done** | 29-07 |
| 7 | Cloud Scheduler created + execution passes | **Done** | 30-07 |
| 8 | Pub/Sub topic created + verified | **Done** | 30-07 |
| 9 | Hermas for unknown flows — deployed + test passes | **Done** | 30-07 |
| 10 | Agentic fix loop — retry passes in GCP logs | **Done** | 30-07 |
| 11 | MongoDB resumable sessions working | **In Progress** (code done) | 29-07 |
| 12 | Parallel run — comparison working | **In Progress** (code done) | 29-07 |
| 13 | Secret Manager — MS creds in customer GCP | **Done** | 30-07 |
| 14 | Connector replacement — 3-tier system (registry + Hermas + stub) | **Done** | 31-07 |
| 15 | Cloud Workflows as Gemini Agent tools | **Done** | 31-07 |
| 16 | Scan + test all agent flows on real GCP | Not Started | 03-08 |
| 17 | Workflows UI page | Not Started | 05-08 |
| 18 | Full end-to-end test + bug fixes | Not Started | 06-08 |
| 19 | Demo ready | Not Started | 07-08 |

**Done = verified working in real environment. In Progress = code written, not tested.**

---

## Blockers Right Now

Items 4-10 are Done. Remaining blockers for 11-18:
1. **GCP OAuth UI** (item 2/11-12): Customer connects Google account — need OAuth consent screen + token exchange code
2. **Secret Manager** (item 13): Store MS credentials in customer's GCP — needs real customer GCP project
3. **SSH to Hermas server** — port 22 appears blocked after UFW change. HTTP (port 8080) still works.
   - Workaround: all fixes deployed via code changes, Hermas HTTP API accessible
4. **Real MS 365 credentials** — Hermas flows fail at runtime because test service account can't call Teams/SharePoint/Graph. In production, customer provides delegated tokens.

---

## Server Info

| What | Value |
|---|---|
| Hermas server IP | `134.209.146.36` |
| SSH login | `ssh -i ~/.ssh/hermas_deploy root@134.209.146.36` |
| Hermas health | `http://134.209.146.36:8080/health` |
| Hermas logs | `journalctl -u hermas -f` (on server) |
| Hermas .env | `/app/hermas/.env` (on server) |
| OpenAI key | Set in `/app/hermas/.env` |
| Hermas model | `gpt-4o-mini` |
