# Handoff: Knowledge & Connector Migration (ADK path)

**Date**: 2026-08-06 (supersedes the earlier handoff of the same date)
**Branch**: `business` — pushed, `dc247d8..086362f`
**Commits**: `6a50633` (ADK path + live connector tools), `086362f` (merge with `dc247d8`)

> **Read this section before anything else.** The previous handoff was built on five
> platform claims that are wrong. Each was disproved live today against
> `studio-enterprise-migration`. If you act on the old document you will re-derive
> the same dead ends.

---

## 1. Corrections to the previous handoff

| Previous claim | Reality | Evidence |
|---|---|---|
| "ADK/Reasoning Engine agents fail at query time — `class_method='query'` is a hardcoded Google platform bug, confirmed across 7 RE ids" | **Not a platform bug.** ADK-framework engines expose **no `query` method at all** — only `create_session`, `stream_query`, `async_stream_query`, `streaming_agent_run_with_events`. `stream_query` also requires `user_id`. Called correctly they answer fine. | `_diag_re_class_methods.ts`, `_probe_re_stream_query.ts` |
| "Low-code agent chat API does not exist — `sessions/{id}/answers` 404s universally" | Wrong endpoint. `engines/*/servingConfigs/default_search:answer` works (`state: SUCCEEDED`, citations), and `assistants/default_assistant:streamAssist` streams. There is genuinely **no way to invoke a specific low-code agent** — `agentsSpec.agentSpecs[].agentId` is accepted and then ignored (a bogus id behaves identically). | `_probe_assist_agent.ts`, `_probe_agents_spec.ts` |
| "Agent state is immutable; `:publish` returns 200 but state stays PRIVATE" | Half right. `Agent.state` **is** `readOnly` in the API — but **`:publish` does not exist as a method at all**, so `publishAgent()` in `services/gemini.ts` calls a nonexistent verb and its 200 means nothing. `sharingConfig.scope` **is** writable, and setting `ALL_USERS` does **not** change state. | v1alpha discovery doc; `_diag_patch_sharing.ts` |
| "Publishing requires a UI click by an admin" | True for **low-code** agents only. **ADK agents register `state: ENABLED` automatically** — no console click, ever. This removes the blocker the old handoff called 🔴 Immediate. | `registerAdkAgent` + every ENABLED agent on the engine |
| "LLM addon not enabled — use our own RAG" | Only true at **data-store** level. Engine-level `:answer` returns grounded, cited answers. The hand-rolled Vertex RAG in `_test_zara_rag_vtx.ts` is unnecessary. | `_probe_assist_agent.ts` step 4 |

**Root cause of "the agent doesn't work"**: `cf-knowledge-eng-hr` was never in
`engine.dataStoreIds`. The agent's `dataStoreSpecs` pointed at a store the engine could
not see, so every grounded path failed with
`400 Data stores ... are not found in the engine`. The old "5 questions passed" proof used
the data-store `:search` API directly, which bypasses the engine — so it never caught this.

---

## 2. What is working now

### Agents (project `studio-enterprise-migration`, engine `gemini-enterprise-17847887_1784788734248`)

| Agent | ID | Reasoning Engine | What it is |
|---|---|---|---|
| **Confluence Agent — Live + Cited v2 (ADK)** | `13332936524828407630` | `2859796208740728832` | Indexed ITINFRA+SALES **+ live company-wide Confluence tool + required citations**. The one to demo. |
| IT + Sales Knowledge Agent v2 (ADK) | `1731617027314167057` | `2499508238551089152` | Indexed ITINFRA+SALES only |
| Confluence Knowledge Agent | `10065544401725915235` | — | Old low-code, still `PRIVATE`, needs a console click. Superseded. |

Both ADK agents are `state: ENABLED` and `framework: google-adk` with the full session
method set the Gemini Enterprise UI requires.

**Deleted today** (4 agents + 4 Reasoning Engines, which bill separately):
wrapper build `IT + Sales Knowledge Agent (ADK)`, and three `ImportError` builds
(`IT + Sales Agent w/ Live Confluence (ADK)`, `… v2`, `Confluence Agent — Live + Cited (ADK)`).

### Data stores

| Data store | Contents | Engine-attached |
|---|---|---|
| `e2e-itinfra-sales-confluence` | 10 pages, ITINFRA + SALES | yes |
| `cf-knowledge-eng-hr` | Confluence ENG + HR | yes (attached today — was the bug) |

### Secrets & IAM

- `studio-enterprise-confluence-base-url` / `-email` / `-api-token`
- RE runtime SA `service-231705905417@gcp-sa-aiplatform-re.iam.gserviceaccount.com` holds
  `roles/discoveryengine.viewer` **and** `roles/secretmanager.secretAccessor`

### Verified results

Indexed questions answer with `[INDEXED]` citations. **ENG and HR are not in this agent's
index**, yet both answer with `[LIVE]` citations and working URLs — which can only come
from a real Confluence call. Out-of-scope questions are refused with no invented sources.

The proof is not the answer text, it's the runtime's own record:

```json
"function_response": {
  "name": "confluence_live_search",
  "response": {"results": [{"title": "Leave Policy", "space": "Human Resources",
    "url": "https://cf2020.atlassian.net/wiki/spaces/HR/pages/120487937/Leave+Policy",
    "excerpt": "Casual Leave 12 No | Sick Leave 10 No | Earned Leave 15 Up to 30 days ..."}]}
}
```

A model cannot author a `function_response` — it is the container's record of what the tool
returned. No `credential lookup failed`, so the Secret Manager read succeeded.

---

## 3. Architecture

### Track A — knowledge (indexed)

```
Copilot knowledge source (Confluence space / SharePoint / file / Dataverse table)
  → knowledgeConnectorScan detects it
  → confluenceMigrator / knowledgeDataStoreExecutor crawls + indexes
  → Discovery Engine data store
  → BOTH links required:
       agent  --dataStoreSpecs-->  store     (low-code)
       engine --dataStoreIds  -->  store     (or the engine rejects it)
  → ADK path instead bakes the resource path into VertexAiSearchTool at deploy time,
    needing no engine attach and no propagation wait
```

### Track B — live action connectors (now real)

```
Copilot agent uses a PA flow with a Slack/Jira/HubSpot connector
  → thirdPartyConnectorScan detects the connector api name
  → customer supplies DURABLE app credentials in ConnectorConfig
  → values → Secret Manager;  field names + secret ids → MongoDB connectorCredentials
  → buildLiveConnectorSpecs(ids) → AdkSpec.liveConnectors   (secret IDS only)
  → adk_deploy.py _build_live_connector_tool() → a real Python function tool
  → at inference: tool reads the secret, builds/mints auth, calls the API
```

**The old instruction-block approach is dead and must not come back.** Pasting a base URL
and bearer token into the agent instruction (a) gave the model no HTTP capability — it could
only narrate a curl command or hallucinate a response — and (b) leaked customer tokens and
an Azure client secret to any user who asked the agent to repeat its prompt.
`buildConnectorInstructionBlock` is marked `@deprecated` with that reasoning.

### Auth: ask for what the customer can actually produce

Customers cannot mint access tokens, and those expire within the hour. Each connector
declares an `authKind`; the container builds the header and mints/refreshes tokens itself.

| authKind | Customer supplies | Connectors |
|---|---|---|
| `bearer` | one long-lived token | HubSpot, Slack, GitHub, GitLab, Notion, Asana, Monday, Airtable, Stripe, SendGrid, Pipedrive, Intercom |
| `basic-userpass` | email + token, or user + password (**we** base64 it) | Confluence, Jira, ServiceNow, Zendesk, Freshdesk, Twilio |
| `oauth2-client-credentials` | tenant/client id + secret | SharePoint, OneDrive, Teams, Outlook, Planner, Dynamics 365, Salesforce |
| `google-service-account` | service-account JSON key (+ optional impersonate user) | Google Drive |
| `oauth2-refresh-token` | client id/secret + refresh token | (wired; no connector uses it yet) |

Tokens are cached in-container until `expires_in` minus 60s.

---

## 4. Key files

| File | Role |
|---|---|
`server/scripts/adk_deploy.py` | Deploys a plain **AdkApp**; builds live connector tools + per-store search tools
`server/src/services/adkDeployer.ts` | `AdkSpec.liveConnectors`, RE deploy, `registerAdkAgent`, IAM grant
`server/src/services/adkAgentChat.ts` | **New** — invocation contract (`stream_query` + `user_id`), error_code detection
`server/src/services/connectorToolBuilder.ts` | `buildLiveConnectorSpecs` / `buildLiveConnectorInstruction`; legacy block deprecated
`server/src/connectors/registry.ts` | 33 connectors with `authKind`, token URLs, scopes
`server/src/db/repos/connectorCredentials.ts` | **New** — per-customer connector state (never values)
`server/src/routes/migrate.ts` | connector detection + credential save/list/delete
`server/src/routes/destination.ts` | `GET /migrated-agents`, `POST /agent-chat`
`web/src/pages/ConnectorConfig.tsx` | Per-connector credential cards, saved-state aware
`server/src/orchestrator.ts` | ADK-first routing; always attaches data stores

### Reproduce / verify (no agent creation)

```bash
cd server
npx tsx src/spikes/_diag_re_class_methods.ts             # what RE methods really exist
npx tsx src/spikes/_diag_live_tool_evidence.ts 2859796208740728832   # real API call proof
npx tsx src/spikes/_probe_adk_agent_answers.ts 2859796208740728832  # ask the live agent
npx tsx src/spikes/_del_broken_adk_agents.ts             # dry run; --apply to delete
```

---

## 5. Fixed today (all found by live probing)

1. `orchestrator.ts` — connector-grounded agents no longer divert to low-code; they deploy via ADK.
2. `orchestrator.ts` — `attachDataStoreToEngine` always runs. `dataStoreSpecs` never exempted it.
3. `adkDeployer.ts` — RE service agent is keyed by project **number**, not id. The grant silently never applied, so grounded agents 403'd on any project not granted by hand.
4. `adk_deploy.py` — deploy plain `AdkApp`, not `ReasoningEngineAgentWrapper`. The wrapper existed only to expose `query()`; the cost was losing the session methods the UI calls, so its agents 400'd in the console.
5. `adk_deploy.py` — `google-cloud-discoveryengine` is required once an agent has 2+ tools. Without it every turn failed at inference with `ImportError: cannot import name 'discoveryengine_v1beta'` and returned an **empty** answer.
6. `adkAgentChat.ts` — a 200 from `stream_query` does not mean an answer. Detect the `error_code` event instead of reporting a successful empty reply. **This is what turned four silent empty answers into a named ImportError.**
7. `registry.ts` — durable app credentials instead of access tokens; base64 done by us.
8. `connectorCredentials` repo — connector setup survives the session TTL.
9. Five old spikes had a **live Atlassian token hardcoded** — scrubbed to env vars before the commit.

---

## 6. Known limits — report these honestly, do not paper over them

- **Source ACLs do not survive.** App-level credentials plus org-wide `ENABLED` agents mean the agent reads everything the credential can, for anyone who asks. Demonstrated: the agent returned `Q1 2026 Revenue Targets (Confidential)` in full, including its own "CONFIDENTIAL — Sales leadership only" line. The live tool runs as Sujana's token, so its reach is *wider* than the indexed copy.
- **Power Automate flow logic is not migrated.** We migrate API *access*; triggers, conditions and loops are not reproduced. Connector notes are `needs-review`, never `mapped`.
- **`awaitImport` false negative** — reported `succeeded: 0` and discarded a working `dataStoreId` while all 10 documents were indexed (`confluenceMigrator.ts:323`).
- **`resolveDestination` can return a non-agent engine** — it picked `cf-knowledge-search`, whose agents endpoint 404s. Spikes pin the engine via `E2E_ENGINE`; the resolver still needs to require assistant support.
- **Data-store attach propagation is uneven** — ~5 min, and replicas settle at different times. Never report success from the engine PATCH alone.
- **`usedDataStoreSpecs` is dead** — never assigned true; two reads remain in the Dataverse and Confluence note blocks.
- **Dropbox and Box** still ask for access tokens.
- **Agent creation is quota-limited** (~7/day). Do not burn deploys on exploratory testing — probe existing agents instead.

---

## 7. Next steps

| Priority | Task | Why |
|---|---|---|
| 🔴 | **Rotate the Confluence API token** | It was pasted into a chat session. Update `studio-enterprise-confluence-api-token`; no redeploy needed (read per call). |
| 🔴 | **Tenant-scope secret ids** | `connectorSecretId()` has no `appUserId`, so two customers or two Jira instances collide. This violates the `appUserId` rule in `.claude/rules/security-rules.md`. |
| 🟡 | **Validate-on-save probe** | "✓ Saved" currently means "stored", not "works". Every credential mistake becomes a runtime failure inside a customer's agent. |
| 🟡 | **One live deploy with Jira or SharePoint** | `basic-userpass` and `oauth2-client-credentials` are written but never executed. Costs one quota unit. |
| 🟡 | Connector health state (`ok / needs_reconsent / invalid / untested`) + `requiredPermissions` checklist in the UI | A missing Graph admin consent still returns a token, then 403s on every call |
| 🟢 | Generic OAuth consent layer | Provider table + start/callback routes + refresh-token rotation write-back + Atlassian `cloudId` base-URL switch. One implementation serves all providers; register apps incrementally. |
| 🟢 | Fix `awaitImport`, `resolveDestination`, Dropbox/Box, dead flag | Cleanup of the above |

**On OAuth:** Copilot Studio shows a consent screen because *Microsoft* pre-registered an
app with Atlassian. To match it, CloudFuze must register a developer app per provider
(Atlassian, Google, Slack, HubSpot…). Until then family `bearer` / `basic-userpass` /
`client-credentials` covers every connector, and the UI should show **Connect** only where
an app is registered and fall back to manual fields elsewhere — so no connector is blocked
waiting on provider registration.

---

## 8. Environment notes

- SA: `studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com`, `roles/owner`
- Project number `231705905417` — needed for both service-agent grants
- `ADK_STAGING_BUCKET` must include the `gs://` prefix for the Python SDK (the Confluence migrator strips it; the deployer requires it)
- Confluence test site `https://cf2020.atlassian.net`, 22 spaces, token belongs to **Sujana** (`laxman.kadari@` returns 403 with it)
- Deploys take 4–6 minutes; run them in the background
