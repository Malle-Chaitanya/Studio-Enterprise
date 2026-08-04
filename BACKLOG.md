# Studio Migrate — Backlog

## Original Task List

- [x] #1 Connector replacement system
- [ ] #2 Scan Copilot Studio agent flows from Dataverse
- [ ] #3 Workflows UI page
- [ ] #4 Verify MongoDB sessions and parallel runner
- [ ] #5 Test all agent flows end-to-end on real GCP
- [x] #6 Secret management for MS credentials in production
- [ ] #7 Register Cloud Workflows as Gemini Agent tools

## Agent Platform / Demo

- [ ] Run `python adk-agent/deploy.py` — deploys ADK agent to Vertex AI Agent Engine, appears in Agent Platform Studio as "Studio Migrate Agent"
- [ ] Verify ADK agent tools work end-to-end (create task → Cloud Workflow → response)
- [ ] Wire `provision-agent` call into migration flow so Dialogflow CX agent is auto-created after migration completes (no manual step)

## Migration Pipeline

- [ ] Scan Copilot Studio agent flows from Dataverse (task #2)
- [ ] Verify MongoDB sessions and parallel runner (task #4)
- [ ] Test all agent flows end-to-end on real GCP (task #5)

## UI

- [ ] Workflows UI page — show migrated Cloud Workflows with status, last run, trigger button (task #3)

## Agent Tools Registration

- [ ] Auto-register migrated workflows as Dialogflow CX tools in `provisionMigrationAgent` (currently hardcoded to demo tool)
- [ ] Generic `execute_workflow` tool in ADK agent should list available workflows dynamically

## MCP

- [ ] `/mcp` SSE endpoint deployed to Cloud Run — usable by Claude Desktop and other MCP clients
- [ ] Test MCP endpoint with Claude Desktop: add `https://studio-enterprise-server-231705905417.us-central1.run.app/mcp`
