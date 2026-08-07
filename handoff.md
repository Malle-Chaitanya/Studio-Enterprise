# Handoff — Migration pipeline, connectors, and what to do next

**Date**: 2026-08-07
**Branch**: `business` — pushed through `7d7d5e8`
**Supersedes**: the 2026-08-06 handoff (its central claims were wrong; see §7)

Two real migrations now run end to end through the product path
(`resolveScope()` → `runMigration()`, the same code `GET /api/migrate/stream` uses).
Read §4 before trusting any "verified" result.

---

## 1. What is proven

| Capability | Evidence |
|---|---|
| **ADK deploy → `ENABLED`** | Both migrations: `deployed=true`, no console Publish click |
| **Topics → sub-agents** | `3 topic(s) → sub-agents in one engine` — one Reasoning Engine, one quota unit, any number of topics |
| **SharePoint knowledge via Graph** | `sharePointMigrator` crawled the source-named folder, indexed, wired as `VertexAiSearchTool` |
| **Confluence knowledge** | 5 pages indexed for `Confluence_agent` |
| **Live connector tools** | `connectors wired: shared_confluence` → real function tool; credentials read from Secret Manager per call |
| **Live SharePoint tools, scoped** | Agent lists/reads only the folder its source named, and refuses "list every site in the tenant" |
| **Reading file content live** | `.md` and `.txt` proven; `pypdf`/`python-docx`/`openpyxl` in-container for PDF/Word/Excel |
| **Connector detection, structural** | `shared_confluence`, `shared_jira`, `shared_sharepointonline` all `certain`, attributed per agent |
| **`verified` fails a broken agent** | Grounded agents must show a tool that returned data; broken → `false`, working → `true`. See §4 |

### Live agents (project `studio-enterprise-migration`, engine `gemini-enterprise-17847887_1784788734248`)

| Agent | ID | What it is |
|---|---|---|
| `Confluence Agent — Live + Cited v2 (ADK)` | `13332936524828407630` | hand-built: indexed + live + citations. **Best demo.** |
| `CloudFuze Studio Migrate (full: docs + live + topics)` | `1326005160808304638` | hand-built: store + live tools + topic sub-agents |
| `CloudFuze Studio Migrate` | `8277338168224151082` | **migrated by the product** — but its stores are in the GTM project, so retrieval 403s |
| `Confluence_agent` | `17674689114292745852` | **migrated by the product**, 5 Confluence pages indexed |

---

## 2. The three ways a connector appears in Copilot Studio

This took most of a day to establish. All three are needed; we handled them in this order:

1. **Knowledge source** (`componenttype 16`) — `kind:` enum names the product for SharePoint
   (`SharePointSearchSource`), but **not** for Confluence: every federated connector is a
   generic `FederatedStructuredSearchSource`. Identity then lives only in
   `description` / `schemaname` / `skillConfiguration`, which are user-editable — one
   source in the test tenant is spelled **"confulence"**. Reported `confidence: 'heuristic'`.
2. **Agent action / ConnectorTool** (`componenttype 9`) — the product names the connector
   outright, so this is `certain`:
   ```yaml
   kind: ConnectorTool
   connectorId: /providers/Microsoft.PowerApps/apis/shared_confluence
   operationId: GetPages
   ```
   This is how Jira was found, with its real operations. Any registry connector used as an
   action surfaces here with no per-connector work.
3. **Power Automate flow** — environment-level (`workflows?$filter=category eq 5`). **Still
   not attributable to an agent.** See §5.

Agent attribution comes from `_parentbotid_value` on the component.

---

## 3. Architecture as built

```
TRACK A — knowledge (indexed)
  source URL/space → crawl (Graph / Confluence REST) → GCS → Discovery Engine data store
  → baked into the agent as VertexAiSearchTool at deploy time
  Answers "what do our documents say", every file type, with citations.

TRACK B — live connector tools
  credentials → Secret Manager (group-scoped) → AdkSpec.liveConnectors
  → real Python function tool in the deployed Reasoning Engine
  Answers "what is there right now" and performs actions.

TOPICS → ADK sub_agents inside the SAME Reasoning Engine (never one engine per topic).
```

**ADK only — there is no low-code fallback.** It was removed deliberately: a low-code agent
is created `PRIVATE` (state is readOnly, no `:publish` method exists), cannot be invoked by
any API, and carries no connector tools or sub-agents. It also masked two real bugs by
turning them into "successful" migrations.

Credentials ask for durable app credentials, never an access token. `authKind` drives header
construction and token minting. **Credential groups**: one Azure app serves all five
Microsoft connectors; one Atlassian token serves Confluence and Jira.

---

## 4. ✅ `verified` now means something (fixed 2026-08-07)

When `expectsGrounding` is true, verification requires **positive evidence a tool returned
data** — a non-error `function_response`, or grounding chunks / retrieved context. Three
outcomes now fail where all three used to pass:

| Case | Result |
|---|---|
| tool ran and errored (`toolError`) | `false` — "knowledge retrieval failed: …" |
| tool never called (`!toolCalled`) | `false` — "answered without retrieving anything" |
| tool called, returned nothing usable | `false` — "no successful function_response or grounding chunk" |

Both failure shapes are needed, not one: the same broken agent fails **differently between
runs** because the model non-deterministically decides whether to call the tool at all. Two
independent runs of `_test_verify_honesty.ts` caught agent `8277338168224151082` via
`toolError` (403) and via `!toolCalled` respectively. Either check alone is a coin flip.

Evidence is read structurally from the stream (`scanToolEvidence()` in `adkAgentChat.ts`),
never pattern-matched from the model's prose. Each `function_response` window is bounded at
the next one so a failing tool cannot be masked by a neighbouring successful one.

Proven both directions — broken agent `8277338168224151082` → `false`; working agent
`13332936524828407630` → `true` with `[INDEXED] Infrastructure Setup Guide`.

The broken agent's own reply is the reason prose could never be trusted:
> "I can access the team's changelog, roadmap, and known-issues documents."

It retrieved nothing.

---

## 5. What to implement next, in priority order

### 1. ~~Make `verified` mean something~~ — DONE, see §4
`services/verify.ts` + `services/adkAgentChat.ts`. Proven against both known agents.

### 2. Secret Manager in the customer's project  ← start here
Saving credentials fails when the target project is not ours — our SA has no
`secretmanager` rights there, and the UI reports the misleading *"Check that Google is
connected"*. Decide between:
 - customer grants the SA `roles/secretmanager.admin` on their project (document it), or
 - secrets live in our project and the customer's RE service agent is granted read.
Either way the UI must fail early with the real reason, not mid-migration.

### 3. Cache cloud reads
Environments, agents and scans re-fetch on every back-and-forth in the wizard.
`agentIRCache` exists and is now used by `connectors-needed` only. Extend to
`explore/agents` and `explore/environments`, plus a client-side `sessionStorage` layer so
navigating back does not re-hit Dataverse/Graph.

### 4. Show connectors that are already migrated
The connector step hides what is already configured; it should show them as done rather
than omitting them.

### 5. Per-agent attribution for Power Automate connectors
`ConnectorTool` (agent actions) is solved. Flow-based connectors are still
environment-wide, so the UI can list connectors belonging to agents the customer did not
select. Needs the agent → flow link (`workflowid` referenced from an agent component); not
yet found in the test tenant.

### 6. Tenant-scope Secret Manager ids
`connectorSecretId()` has no `appUserId`. Two customers sharing a project, or one customer
with two Jira sites, collide. Violates the `appUserId` rule in
`.claude/rules/security-rules.md`.

### 7. Validate-on-save
"✓ Saved" currently means "stored", not "works". `_probe_ms_graph_creds.ts` already shows
the shape: separate *permission missing* (403 / absent from the token's `roles`) from *no
such data* (404).

---

## 6. Configuration that must be set

```
ADK_STAGING_BUCKET=gs://studio-enterprise-migration-adk-staging
```
Without it the deployer defaults to `<customerProject>-adk-staging`, 403s, and (before the
fallback was removed) silently produced a PRIVATE agent.

Per project, the RE runtime service agent
(`service-<projectNUMBER>@gcp-sa-aiplatform-re.iam.gserviceaccount.com`) needs
`roles/discoveryengine.viewer` and `roles/secretmanager.secretAccessor`. **Project number,
not id** — the id form yields `400 … does not exist` and the grant silently never applies.

Target `studio-enterprise-migration`. The GTM project (`gtm-project-504611`,
number `72860638029`) is where our SA has no Secret Manager or GCS rights; data stores
created there are unreadable by agents deployed elsewhere.

---

## 7. Corrections to the previous handoff

| Previous claim | Reality |
|---|---|
| "ADK agents fail — `class_method='query'` is a Google platform bug" | Ours. ADK engines expose no `query` at all; use `create_session` + `stream_query` with `user_id`. |
| "No chat API exists" | `engines/*/servingConfigs:answer` and `assistants:streamAssist` both work. Agent-specific invocation genuinely does not. |
| "`:publish` returns 200 but state stays PRIVATE" | There is no `:publish` method. `Agent.state` is `readOnly`. ADK registration returns `ENABLED` directly. |
| "Publishing needs an admin console click" | Only for low-code agents, which we no longer create. |

---

## 8. Failure modes that report success

Every one of these cost real time. Suspect them first.

| Symptom | Cause |
|---|---|
| Agent answers nothing, HTTP 200 | container `ImportError`; stream carried an `error_code` event and no text |
| "0 pages indexed" / document `lost` | `awaitImport` counters lag; the store held the documents. Now verified via `verifyIn` |
| Connector detection returns 0 | a literal **backspace byte** (`0x08`) written instead of `\b` in a regex — typecheck passed, `cat -A` revealed `^Hkind:` |
| Migration "succeeds" with PRIVATE agents | `ADK_STAGING_BUCKET` unset → 403 → silent low-code fallback (now removed) |
| Store parsed badly | `documentProcessingConfig` **rejects `updateMask`** — the only DE endpoint that does |
| Agent deployed but retrieves nothing | data stores in a different project from the agent (cache key lacked project) |
| `verified: true` on a broken agent | the probe never forced a tool call — **fixed**, §4. Note the shape: the check only looked for a tool that *failed*, so a tool that never ran read as clean |

Rule: a best-effort call that degrades quality must still be reported, and a 200 is not an
answer.

---

## 9. Useful commands

```bash
cd server
npx tsx src/spikes/_test_two_tier_detection.ts <envUrl>        # what connectors each agent has
npx tsx src/spikes/_diag_component_dump.ts <envUrl> <botId>    # raw components (finds ConnectorTool)
npx tsx src/spikes/_probe_ms_graph_creds.ts                    # Graph permissions: missing vs no data
npx tsx src/spikes/_diag_ds_docs.ts <dataStoreId>              # did it actually index?
npx tsx src/spikes/_probe_adk_agent_answers.ts <reasoningEngineId>
npx tsx src/spikes/_diag_live_tool_evidence.ts <reId> "<question>"   # proof a tool really ran
npx tsx src/spikes/_e2e_real_migration.ts "<agent>" <envUrl> <project>
```

See `docs/connector-architecture-decisions.md` for why the Graph path beats Google's native
SharePoint connector (certificate requirement, `appidacr=2`), measured document counts, and
the ACL trade-offs.

---

## 10. Housekeeping

- **Rotate the Confluence API token** — it was pasted into a chat session and is live in
  Secret Manager as `studio-enterprise-atlassian-api-token`. Rotating means updating that
  secret; no redeploy needed.
- **Rotate the `ConnectorsTest` client secret** — also pasted into chat.
- Source ACLs are **not** preserved on either path, and ADK agents register org-wide
  `ALL_USERS`. Reported as a fidelity note; must be said out loud to a customer.
- `Sites.Read.All` is tenant-wide — 99 sites in the test tenant. Scope the *tool*, not the
  credential.
