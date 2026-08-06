# Handoff: CloudFuze Studio Migrate — Knowledge Base & Connector Work

**Date**: 2026-08-06  
**Branch**: `business`  
**Engineer**: Laxman Kadari

---

## What Was Proven / Completed

### 1. Knowledge Base End-to-End Chain ✅

Full RAG chain working in production project `studio-enterprise-migration`:

```
Confluence pages
  → Discovery Engine data store (cf-knowledge-eng-hr)
  → :search API → snippets with snippet_status=SUCCESS
  → Vertex AI gemini-2.5-flash (us-central1)
  → Grounded answer
```

All 5 test questions passed:
- "What is the sick leave policy?" → "10 days/year, cannot be carried forward"
- "How many days of earned leave?" → correct answer from HR-leave-policy
- "What are the Python coding standards?" → PEP 8, type hints, from ENG-coding-standards
- "How do engineers deploy?" → Staging → Production flow from ENG-deployment-guide
- "What is the maternity leave policy?" → correct from HR-leave-policy

**Spike to reproduce**: `server/src/spikes/_test_zara_rag_vtx.ts`

---

### 2. Confluence Knowledge Agent Created ✅

Agent created in Zara's project via API:

| Field | Value |
|-------|-------|
| Agent ID | `10065544401725915235` |
| Display name | Confluence Knowledge Agent |
| Project | `studio-enterprise-migration` |
| Engine | `gemini-enterprise-17847887_1784788734248` |
| Data store | `cf-knowledge-eng-hr` (Confluence ENG + HR) |
| Wired via | `dataStoreSpecs.specs[0].dataStore` |
| State | **PRIVATE** (blocked — see below) |
| Created by | SA `studio-enterprise-migration@...iam.gserviceaccount.com` |

Agent visible in Agentspace UI but not usable — returns "not allowed" until published.

**Spike that created it**: `server/src/spikes/_create_cf_kb_agent.ts`

---

### 3. Key Platform Bugs / Constraints Confirmed

#### RE `class_method='query'` bug (Google platform bug)
All Reasoning Engine (ADK) agents fail via REST `:query` and `:streamQuery`:
```
400 Reasoning Engine Execution failed
```
Tested on 7 different KB-Grounding-Test-Agent RE IDs in `studio-enterprise-migration`. This is hardcoded in the platform — not fixable from our side.

**Our fix**: Use low-code agents with `dataStoreSpecs` instead of ADK/RE agents for knowledge grounding.

#### Low-code agent chat API does not exist
`sessions/{id}/answers` → 404 universally. Engines have only `default_search (SOLUTION_TYPE_SEARCH)` serving config — no chat endpoint. Chat is only via the Agentspace UI.

#### Agent state is immutable via API
- `PATCH state=ENABLED` → 400 "state is an immutable path"
- `PATCH state=PUBLISHED` → 400 "invalid value"
- `:publish` → 200 but state stays PRIVATE

Publishing **requires a UI click** by an admin in the GCP console.

#### LLM addon not enabled
Discovery Engine search AI summaries (`contentSearchSpec.summarySpec`) → `LLM_ADDON_NOT_ENABLED` on both Standard and Business accounts. Use our RAG approach instead.

---

## Immediate Blocker: Agent Not Accessible

**Error in UI**: "I'm sorry, it seems you are not allowed to perform this operation."  
**Cause**: Agent state is PRIVATE — only SA (creator) can see it, Zara cannot interact.

### Fix (manual, ~1 minute)

**Admin must do this in GCP console:**

1. Go to `console.cloud.google.com/gemini-enterprise`
2. Switch project to **`studio-enterprise-migration`**
3. Navigate: **Apps → gemini-enterprise-1784788734248 → Agents**
4. Find **"Confluence Knowledge Agent"**
5. Click **Publish** (or three-dot menu → Publish)

State changes: PRIVATE → ENABLED. After this, Zara can chat with it at `business.gemini.google`.

---

## Architecture: How Knowledge Connectors Work

### Track A — Knowledge connectors (what's working)

```
Copilot Studio agent has knowledge source (e.g. Confluence space)
  → knowledgeConnectorScan.ts detects source type + space keys
  → confluenceMigrator.ts fetches pages via Confluence REST API
  → pages indexed into Discovery Engine data store
  → data store attached to Gemini low-code agent via dataStoreSpecs
  → agent answers from indexed content (grounded RAG)
```

Supported: Confluence, SharePoint/OneDrive (already built in `services/`)

### Track B — Action connectors (implemented, not wired to UI yet)

```
Copilot Studio agent uses Power Automate flow with Slack / Jira / HubSpot connector
  → thirdPartyConnectorScan.ts scans Dataverse PA flows (category=5)
  → detects connector API name (e.g. shared_slack, shared_jira)
  → customer provides credentials → stored in Secret Manager
  → at migration: connectorToolBuilder.ts resolves credentials
  → builds "## External Connector Access" instruction block
  → embedded in Gemini agent system instruction
  → agent calls third-party APIs live at runtime
```

Registry: `server/src/connectors/registry.ts` — 25+ connectors (HubSpot, Salesforce, Jira, Slack, ServiceNow, GitHub, etc.)

**Gap**: The UI to collect connector credentials and the route to store them in Secret Manager is not wired into the migration flow yet. Registry and tool builder are complete.

---

## Data Store Resource Paths

| Data store | Resource path |
|------------|--------------|
| cf-knowledge-eng-hr | `projects/231705905417/locations/global/collections/default_collection/dataStores/cf-knowledge-eng-hr` |

Project number: `231705905417` (for `studio-enterprise-migration`)

---

## Key Files

| File | Purpose |
|------|---------|
| `server/src/spikes/_create_cf_kb_agent.ts` | Creates/checks the Confluence Knowledge Agent (idempotent) |
| `server/src/spikes/_test_zara_rag_vtx.ts` | Proves RAG chain end-to-end (all 5 questions) |
| `server/src/spikes/_fix_agent_publish.ts` | Confirmed API cannot publish — state immutable |
| `server/src/connectors/registry.ts` | 25+ third-party connector definitions |
| `server/src/services/connectorToolBuilder.ts` | Builds instruction blocks from SM credentials |
| `server/src/services/connectorCredentials.ts` | SM secret ID naming convention |
| `server/src/services/thirdPartyConnectorScan.ts` | Detects connectors in PA flows |
| `server/src/services/confluenceMigrator.ts` | Fetches + indexes Confluence pages |
| `server/src/services/knowledgeConnectorScan.ts` | Scans knowledge sources from Copilot agents |

---

## Next Steps

| Priority | Task |
|----------|------|
| 🔴 Immediate | Admin publish the Confluence Knowledge Agent in GCP console (see above) |
| 🟡 Next | Wire Track B connector credential collection into migration UI (`web/src/pages/ConnectorConfig.tsx` exists) |
| 🟡 Next | Connect `thirdPartyConnectorScan` output to `connectorToolBuilder` in orchestrator |
| 🟢 Later | Add more data stores to the agent (SharePoint connector data) |
| 🟢 Later | Test agent in `business.gemini.google` once ENABLED |

---

## SA & Auth Notes

- SA: `studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com`
- SA has `roles/owner` in `studio-enterprise-migration` project
- No DWD needed — SA belongs to same project
- Vertex AI was enabled programmatically via Service Usage API (already done)
- Use `cloud-platform` scope only for all Discovery Engine + Vertex AI calls
