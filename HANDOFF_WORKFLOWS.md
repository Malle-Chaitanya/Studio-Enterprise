# CloudFuze Studio Migrate — Workflow Migration Handoff

Source: Research session on storefuze D365 tenant  
Data extracted from: `explore_output/flows_all.json`, `explore_output/flows_parsed.json`  
One flow fully migrated: `full_migration/competitor_workflow.yaml`

---

## 1. What Was Extracted

All 73 Power Automate flows pulled from storefuze Dataverse via:
```
GET /api/data/v9.2/workflows?$filter=category eq 5
```
Full flow logic is in the `clientdata` field of each row.

---

## 2. Flow Breakdown by Trigger Type

| Type | Count | GCP Equivalent |
|---|---|---|
| OpenApiConnectionWebhook | 45 | Pub/Sub + Eventarc + Cloud Workflow |
| Recurrence | 17 | Cloud Scheduler + Cloud Workflow |
| Request (HTTP) | 11 | Cloud Run endpoint + Cloud Workflow |
| **Total** | **73** | |

---

## 3. Recurrence Flows (17) — Full Names

```
Sales Agents Initiate Opportunity Research Orchestration flow
Sales Agents Refresh Opportunity Research Orchestration flow
Execute Outreach Agent
Email Insights cleanup Job
Sales Close Agent - Engage - Execute Orchestrator
Execute Handover Microagent
Auto close expired conversations
Sales Close Agent - Engage - Execute Outreach Agent
Sales Insights sequence daily usage flow
Integrated Search API trigger flow
Daily Summary Email flow
Execute Engage And Readiness Agent V2
AI Evaluation Flow for Conversation
Intent Metrics Update Job Scheduled Flow
Expire evaluations
Execute Engage And Readiness Agent
Sales Close Agent - Engage - Orchestrate Engage Activities
```

---

## 4. HTTP Request Flows (11) — Full Names

```
Deal Risk Flow
Deal Importance Flow
Search Dynamics 365 knowledge article flow
Sales Close Agent - Engage - Test Agent
Sales Close Agent - Engage - Execute Engage Agent
Deal Health Flow
Execute Engage Agent
Deal Insights Flow
Execute Engage Agent V2
Deal Overview Flow
Deal Risk Flow V2
```

---

## 5. Webhook Flows (45)

All 45 are `OpenApiConnectionWebhook` type. They watch these Dataverse entities:

```
email
incident
msdyn_accountresearchagenttrigger
msdyn_accountresearchsummarytrigger
msdyn_agentcopilotsetting
msdyn_aiconfiguration
msdyn_aisimulationrun
msdyn_competitorresearchagenttrigger
msdyn_competitorwebresearchagenttrigger
msdyn_customizationagenttrigger
msdyn_dqarankertrigger
msdyn_duplicatedetectionpluginrun
msdyn_evaluation
msdyn_evaluationsimulationrun
msdyn_intentfamily
msdyn_iotalert
msdyn_iotsettings
msdyn_leademailextension
msdyn_ocsitdimportconfig
msdyn_opportunityresearchagenttrigger
msdyn_opportunityresearchuserinteractions
msdyn_outreachtriggeragent
msdyn_qualificationagenttrigger
msdyn_relatedconversationtriggertable
msdyn_routingrequest
msdyn_salesagentprofile
msdyn_salesagentrun
msdyn_salescompanyresolverleadtrigger
msdyn_sequencetargetstep
msdyn_summarysynthesizertrigger
msdyn_swarmparticipant
msdyn_targetcustomerprofileprefillagenttrigger
msdyn_unifiedroutingsetuptracker
none
slakpiinstance
```

---

## 6. Connectors Used

All flows use only these connectors (no SAP, Salesforce, or other third-party):

```
shared_commondataserviceforapps       (Dataverse — dominant)
shared_commondataserviceforapps_1     (Dataverse — alternate ref)
shared_commondataserviceforapps_2     (Dataverse — alternate ref)
shared_microsoftcopilotstudio         (Copilot Studio agent calls)
shared_conversionservice              (HTML to text conversion)
shared_conversionservice_1            (HTML to text — alternate ref)
shared_teams                          (Microsoft Teams messages)
```

---

## 7. All Operation IDs — Count + GCP Mapping

| operationId | Count | Connector | GCP Equivalent |
|---|---|---|---|
| PerformUnboundAction | 318 | Dataverse | POST `/api/data/v9.2/ENTITY/Microsoft.Dynamics.CRM.ACTION` |
| ExecuteCopilotAsyncV2 | 121 | CopilotStudio | POST Gemini Interactions API |
| ListRecords | 119 | Dataverse | GET `/api/data/v9.2/ENTITY?$filter=...` |
| UpdateOnlyRecord | 50 | Dataverse | PATCH `/api/data/v9.2/ENTITY(id)` |
| UpdateRecord | 45 | Dataverse | PATCH `/api/data/v9.2/ENTITY(id)` |
| CreateRecord | 22 | Dataverse | POST `/api/data/v9.2/ENTITY` |
| PerformBoundAction | 21 | Dataverse | POST `/api/data/v9.2/ENTITY(id)/Microsoft.Dynamics.CRM.ACTION` |
| GetItem | 18 | Dataverse | GET `/api/data/v9.2/ENTITY(id)` |
| DeleteRecord | 10 | Dataverse | DELETE `/api/data/v9.2/ENTITY(id)` |
| HtmlToText | 8 | ConversionService | Cloud Function (custom) or strip tags in workflow |
| ContinueExecuteDataverseCopilot | 4 | CopilotStudio | Gemini Interactions API (continuation) |
| ExecuteDataverseCopilotToStart | 3 | CopilotStudio | Gemini Interactions API (start session) |
| GetRelevantRows | 1 | Dataverse | GET `/api/data/v9.2/ENTITY?$search=...` |
| PostCardAndWaitForResponse | 1 | Teams | Google Chat API — send card + poll response |
| PostCardToConversation | 1 | Teams | Google Chat API — send card |

---

## 8. Action Types Inside Flows

These are the internal PA action types that appear inside flow definitions:

| Action Type | Count | YAML Equivalent |
|---|---|---|
| SetVariable | 675 | `assign` step |
| OpenApiConnection | 620 | `http.get` / `http.post` step |
| InitializeVariable | 533 | `assign` step |
| If | 480 | `switch` step |
| Compose | 305 | `assign` step |
| AppendToArrayVariable | 281 | `assign` with list concat |
| ParseJson | 271 | no-op (GCP returns parsed JSON) |
| Foreach | 189 | `for` step |
| OpenApiConnectionWebhook | 122 | trigger — not a step |
| Scope | 78 | group steps (flatten in YAML) |
| AppendToStringVariable | 71 | `assign` with string concat |
| Until | 59 | `for` with break condition |
| Terminate | 46 | `return` step |
| Query | 44 | `http.get` with `$filter` |
| Wait | 41 | `sys.sleep` step |
| Select | 27 | `assign` with list map |
| IncrementVariable | 20 | `assign` with `+ 1` |
| Workflow | 15 | call another Cloud Workflow |
| Response | 12 | `return` step |
| Switch | 7 | `switch` step |

---

## 9. Custom Dataverse Actions (msdyn_*) — 84 Total

These are D365 Sales custom actions called via `PerformUnboundAction`. They are Microsoft-proprietary — no GCP equivalent exists. They must be called via Dataverse REST API using an Entra token at runtime.

```
msdyn_AutoCloseExpiredConversations
msdyn_AutonomousSQA_AssociateOutputForEngageAndReadinessSAR
msdyn_AutonomousSQA_GetLatestQualificationCriteriaEvaluation
msdyn_AutonomousSQA_GetSARsAndAssociatedEmailThreads
msdyn_AutonomousSQA_ProcessBANTAndPIExtraction
msdyn_AutonomousSQA_TriggerQualificationEvaluation
msdyn_AutonomousSQA_UpdateSalesAgentRun
msdyn_CaseSimulation
msdyn_CheckDVCopilotStatus
msdyn_CreateEvaluationRecordsForPlan
msdyn_DCA_SendOutreachEmail
msdyn_DuplicateDetectionTriggerAction
msdyn_EmailValidationCustomAction
msdyn_ExecuteAggregateAndUpdateIntentMetrics
msdyn_ExecuteSIRequest
msdyn_ExecuteSalesAgentByTaskKey
msdyn_FetchFCSValue
msdyn_GetFormattedOpportunityData
msdyn_GetMessageIdsForOpportunityCustomAction
msdyn_GetORReasonExplanation
(+ 64 more in explore_output/flows_parsed.json)
```

All called as:
```
POST https://ORG.crm.dynamics.com/api/data/v9.2/ENTITY(id)/Microsoft.Dynamics.CRM.msdyn_ACTION
Authorization: Bearer {entra_token}
```

---

## 10. One Flow Fully Migrated (Reference)

File: `full_migration/competitor_workflow.yaml`

**Source flow:** Opportunity Competitor Research  
**Trigger:** `OpenApiConnectionWebhook` on `msdyn_competitorresearchagenttrigger`  
**What it does:** Fetches agent config → lists opportunities → calls Gemini agent → saves results back to Dataverse

**What was swapped:**
- `ExecuteCopilotAsyncV2` → Gemini Interactions API
- `shared_commondataserviceforapps` → Dataverse REST API with Entra token

**Known issue in this file:** `client_secret` is passed as `args.dvClientSecret` — not yet pulled from Secret Manager. Must fix before production.

---

## 11. Entra Token Pattern (Confirmed Working)

Every flow that calls Dataverse or MS APIs needs this as the first step:

```yaml
- get_entra_token:
    call: http.post
    args:
      url: ${"https://login.microsoftonline.com/" + args.tenant_id + "/oauth2/v2.0/token"}
      headers:
        Content-Type: application/x-www-form-urlencoded
      body:
        client_id: ${args.client_id}
        client_secret: ${args.client_secret}
        grant_type: client_credentials
        scope: ${"https://" + args.org_url + "/.default"}
    result: entra_token_response
- set_token:
    assign:
      - entra_token: ${entra_token_response.body.access_token}
```

`client_id`, `client_secret`, `tenant_id`, `org_url` must come from Secret Manager — not hardcoded in YAML.

---

## 12. GCP Infrastructure Confirmed Working (storefuze)

```
Project ID:    gem-co-migration
Project num:   860501065102
Region:        us-central1
Org URL:       org32322095.crm.dynamics.com
Tenant ID:     807d6772-847c-40e2-9bec-e2c930b3a42e

Deployed:
  16+ Cloud Workflows
  11 Cloud Scheduler jobs
  27 Reasoning Engines (Gemini agents)
  1 RAG Corpus (us-east5)
  SA: copilot-migration@gem-co-migration.iam.gserviceaccount.com (DWD enabled)
```

---

## 13. Hermas Agent — Built, Not Yet Deployed

Hermas is the autonomous agent that handles unknown/complex flows the rule-based engine cannot convert.

**Files built:**
```
hermas/agent.py          — Claude API call, generates Cloud Workflow YAML
hermas/fix_loop.py       — deploy → test → error → fix → repeat (max 5 retries)
hermas/knowledge_base.py — Firestore, stores patterns that worked (self-learning)
hermas/server.py         — FastAPI, 3 endpoints: /generate /migrate /migrate/batch
hermas/client.py         — called from migration tool
hermas/Dockerfile        — Cloud Run container
hermas/deploy.sh         — one-command deploy script
```

**Endpoints:**
```
POST /generate       — YAML only, no deploy (for preview)
POST /migrate        — full loop: generate → deploy → test → fix
POST /migrate/batch  — all flows at once
GET  /health
GET  /kb/stats
```

**Status:** Code complete. Not deployed to Cloud Run yet.  
**Blocker:** `ANTHROPIC_API_KEY` not yet in Secret Manager.

---

## 14. What Is NOT Done

```
[ ] Hermas deployed to Cloud Run
[ ] Secret Manager storing MS credentials (client_secret hardcoded in competitor_workflow.yaml)
[ ] Rule-based YAML generator for all 3 trigger types
[ ] 72 flows not migrated (only 1 done manually)
[ ] Webhook trigger infrastructure (Dataverse plugin + Pub/Sub + Eventarc)
[ ] Parallel run monitor (output comparison PA vs GCP)
[ ] Multi-customer support (all code is hardcoded for storefuze tenant)
[ ] Cutover script (disable PA flows via API)
```

---

## 15. Files Reference

| File | What It Contains |
|---|---|
| `explore_output/flows_all.json` | Raw 73 flows from Dataverse (1.3MB, full clientdata) |
| `explore_output/flows_parsed.json` | Structured: triggers, actions, connectors per flow |
| `explore_output/connection_references.json` | 25 connection refs, 4 connector types |
| `explore_output/flows_fixed.json` | Cleaned version of flows_all |
| `full_migration/competitor_workflow.yaml` | Only fully migrated flow (reference template) |
| `full_migration/flow_competitor.json` | Source PA flow JSON for competitor flow |
| `hermas/` | Hermas agent service (complete, not deployed) |
| `oauth_tool/server.py` | MS OAuth + Google OAuth + SA+DWD tool |
| `TODO.md` | Sprint task list |
