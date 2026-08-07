# Connector Architecture — Decisions & Evidence

**Date**: 2026-08-07
**Status**: current
**Scope**: how CS_GE migrates knowledge sources and action connectors into Gemini
Enterprise, which of the four possible paths we use, and why.

Everything below was verified live against `studio-enterprise-migration` and the
`filefuze` Microsoft tenant. Where a claim is inferred rather than proven, it says so.

---

## 1. The decision

**Default: the Graph migrator (`services/sharePointMigrator.ts`) plus live connector
tools. Keep Google's native connector as an advanced, ACL-preserving option — clearly
labelled, not on the main path.**

Rationale in one line: the native connector is the only path that preserves SharePoint
permissions, and it is also the only path that currently indexes **zero documents** with
the credentials customers can actually supply.

---

## 2. The four paths, measured

| | Federated connector | Native crawl connector | **Graph migrator** | Live connector tools |
|---|---|---|---|---|
| How | `sharepoint_federated_search`, query-through at search time | `dataSource: sharepoint`, Google crawls and ingests | we crawl via Microsoft Graph, upload to GCS, import | ADK function tool calls Graph per question |
| Works with a client secret | ✅ creates OK | ❌ **needs a certificate** | ✅ | ✅ |
| Documents actually indexed | **0** (by design — no ingestion) | **0** (401 on every crawl) | **1** (proven) | n/a |
| Preserves SharePoint ACLs | ❌ store is `aclEnabled: false` | ✅ + daily identity refresh | ❌ `aclEnabled: false` | ❌ one app identity |
| Reads PDF/Word/Excel/images | — | ✅ layout parser + image annotation | ✅ same parser, we set it explicitly | ⚠️ pypdf/docx in-container; no OCR |
| Freshness | live | sync interval (86400s default) | re-run the migration | ✅ always current |
| Answers "what's in all these docs?" | ✅ if it ingested | ✅ | ✅ | ❌ one file per call |
| Answers "what's there right now?" | ⚠️ | ❌ snapshot | ❌ snapshot | ✅ |

### Evidence

```
filefuze-sp-22734671df75_file      0 documents   federated
filefuze-sp-d4a33c3a8821_file      0 documents   federated
connectortest_1785961359928_file   0 documents   native crawl, state=WARNING
ee2ea155-…-sharepoint              1 document    Graph migrator ✅
```

Reproduce: `npx tsx src/spikes/_diag_ds_docs.ts <dataStoreId>`

The native crawl connector's own sync run says why:

```
entity=file state=FAILED extracted=0 indexed=0
"Authentication failed due to invalid credentials. Check credentials and re-authenticate…"
```

Reproduce: `npx tsx src/spikes/_diag_connector_runs.ts <collectionId>`
(note: `connectorRuns` requires the project **number**, not the project id)

---

## 3. Why the native connector fails: certificate, not permissions

This looked like a rotated secret or a missing scope for hours. It is neither.

```
Graph token       aud=graph.microsoft.com   roles=Sites.Read.All, Files.Read.All, …   ✅
SharePoint token  aud=00000003-0000-0ff1-ce00-…   roles=Sites.Read.All, Sites.FullControl.All
GET /_api/web/lists → 401 "Unsupported app only token."
appidacr = 1   (1 = client secret, 2 = certificate)
```

SharePoint's REST API accepts app-only tokens **only when minted with a certificate**.
A client secret stamps `appidacr: 1` and SharePoint refuses it regardless of which
permissions are granted. Microsoft Graph accepts both — which is why everything we build
on Graph works and the connector does not.

Two consequences worth remembering:

1. **Graph permissions ≠ SharePoint permissions.** In Azure, `Sites.Read.All` exists
   twice — once under Microsoft Graph, once under the SharePoint API. Granting the Graph
   one does nothing for SharePoint REST.
2. The identity sync of the same connector **succeeds** (it uses Graph), so a partly-green
   connector is not evidence that the crawl works.

Reproduce: `npx tsx src/spikes/_probe_sharepoint_api_perms.ts`

---

## 4. Recommendation for the UI: keep both, demote one

The wizard currently has **two** connector pages, which is the source of "where do I
connect?":

- `/connector-config` — **Connector Credentials**: collects the app/token once, drives
  both the Graph crawl and the live tools, shows required permissions. **Keep as the
  main path.**
- `/connectors` — **Connectors needed**: creates Google's native connector per site.
  **Demote** behind an "Advanced: ACL-preserving indexing (requires a certificate)"
  link.

Why demote rather than delete: the native connector is the *only* way to preserve
per-file SharePoint permissions, with a daily identity refresh. Nobody has configured a
certificate yet, so today it produces empty stores and misleads — but deleting it throws
away the only ACL-capable path the moment someone does.

---

## 5. Track A vs Track B — what each is for

```
TRACK A — knowledge (indexed)
  Copilot knowledge source → crawl → Discovery Engine data store
                           → baked into the agent as VertexAiSearchTool at deploy
  Answers: "what do our documents SAY?"  Reads every file type. Cites sources.

TRACK B — live action connectors
  Copilot connector → credentials in Secret Manager
                    → real ADK function tool in the deployed agent
                    → calls the third-party API at question time
  Answers: "what is there RIGHT NOW?" and performs actions.
```

Both can live on one agent, and should. Proven working together:
`Confluence Agent — Live + Cited v2 (ADK)` and
`CloudFuze Studio Migrate (full: docs + live + topics)`.

### Instruction blocks are not connectors

The original design pasted base URLs and bearer tokens into the agent instruction. That
could never work — an LLM handed a token in its prompt has no way to make an HTTP
request; it narrates a curl command or invents a response. It was also unsafe: anything
in an instruction is retrievable by asking the agent to repeat its prompt, so this
published customer tokens and an Azure client secret to every user of an org-wide agent.
`buildConnectorInstructionBlock` is `@deprecated` and must not come back.

---

## 6. Credentials: ask for what the customer can actually produce

Customers cannot mint access tokens, and those expire within the hour. Every connector
declares an `authKind`; the container builds the header and mints/refreshes itself.

| authKind | Customer supplies | Connectors |
|---|---|---|
| `bearer` | one long-lived token | HubSpot, Slack, GitHub, Notion, Asana, Monday, Airtable, Stripe, … |
| `basic-userpass` | email + token, or user + password (**we** base64 it) | Confluence, Jira, ServiceNow, Zendesk, Freshdesk, Twilio |
| `oauth2-client-credentials` | tenant + client id + secret | SharePoint, OneDrive, Teams, Outlook, Planner, Dynamics, Salesforce |
| `google-service-account` | service-account JSON key | Google Drive |
| `oauth2-refresh-token` | client id/secret + refresh token | wired, unused |

**Credential groups**: one Azure App Registration serves all five Microsoft connectors;
one Atlassian token serves Confluence and Jira. Secrets are stored under the *group*
scope (`studio-enterprise-ms-graph-client-secret`), so a later-detected sibling asks only
for the extra **permission**, never for the credential again.

Granting a credential is not granting access — a Microsoft `client_credentials` exchange
returns a token even with nothing consented, then 403s on every call. Hence the
permission checklist in the UI and `_probe_ms_graph_creds.ts`, which separates
*permission missing* (403 / absent from the token's `roles`) from *no such data* (404).

---

## 7. Detecting connectors: two tiers, and never trust names

Copilot Studio does not name most connectors structurally.

**Tier 1 — structural (certain)**
- `kind:` enum in the knowledge source: `SharePointSearchSource`,
  `SharePointKnowledgeSource`, `DataverseStructuredSearchSource`, `PublicSiteSearchSource`
- `shared_*` api names appearing in connection references / `InvokeConnectorTaskAction`
- `_parentbotid_value` gives the owning agent — real per-agent attribution

**Tier 2 — heuristic (flagged)**
- Confluence and every other federated connector arrive as
  `FederatedStructuredSearchSource`. The enum says only "federated"; the product name
  survives only in `description` / `schemaname` / `skillConfiguration`, which are
  user-editable — one source in the test tenant is spelled **"confulence"**.
- These are returned with `confidence: 'heuristic'` and shown as **LIKELY** in the UI,
  never as a requirement.

Result on the real tenant:

```
shared_sharepointonline [certain]    HR Policy Assistant, HR AGENT, IT Help Desk Agent, CloudFuze Studio Migrate
shared_confluence       [heuristic]  Confluence_agent, Enterprise Knowledge & Action Agent
```

`Dataverse` and `PublicSite` sources map to no connector, so we no longer ask for
credentials nothing needs.

**Still open**: Power Automate connectors are detected per *environment*, not per agent —
`workflows?$filter=category eq 5` has no agent link. Only one agent in the test tenant
(`Dev Help Desk Agent`) carries a connection reference naming its connector. Until the
agent→flow link is found, flow-based connectors must be labelled environment-wide.

---

## 8. Permissions reality — say this to customers

- **Indexed content** *can* be ACL-trimmed, but only via the native connector with a
  certificate **and** an identity mapping store. None exists in the project today.
- **Live tools** cannot be ACL-trimmed at all: one app identity, no per-user context.
- ADK agents register `state: ENABLED`, which is **org-wide**. There is no per-user agent
  visibility in the Gemini API.
- `Sites.Read.All` is tenant-wide — Graph has no per-site application permission. In the
  test tenant that is **99 sites**.

Therefore: scope the *tool*, not the credential. The SharePoint tools are confined to the
folder the source agent named (`scopeUri`), so the agent refuses "list every site in the
tenant" even though the credential could. Demonstrated live.

A migrated agent must carry a `needs-review` fidelity note naming the identity it runs as
and stating that source ACLs were not preserved.

---

## 9. Failure modes that report success

Four separate bugs today looked like success. Worth a standing suspicion.

| Symptom | Actual cause |
|---|---|
| Agent answers nothing, HTTP 200 | container `ImportError`; the stream carried an `error_code` event and no text |
| Store indexed but parsed badly | `documentProcessingConfig` **rejects `updateMask`** (`400 Field "updateMask" is unsupported`) — the only DE endpoint that does. Best-effort call swallowed it and left the default parser |
| Connector detection returns 0 | a literal **backspace byte** (`0x08`) written instead of `\b` in a regex. Typecheck passed; only `cat -A` showed `^Hkind:` |
| Migration "succeeds" with PRIVATE agents | `ADK_STAGING_BUCKET` unset → deployer defaulted to `<customerProject>-adk-staging` → 403 → silent fallback to low-code |

Rule of thumb: a best-effort call that degrades quality must still be *reported*, and a
200 is not an answer.

---

## 10. Configuration that must be set

```
ADK_STAGING_BUCKET=gs://studio-enterprise-migration-adk-staging
```

Without it every ADK deploy 403s on the customer project's bucket and silently falls back
to a low-code (PRIVATE) agent with no connector tools and no sub-agents.

Also required, per project:
- RE runtime service agent (`service-<projectNUMBER>@gcp-sa-aiplatform-re…`) needs
  `roles/discoveryengine.viewer` **and** `roles/secretmanager.secretAccessor`.
  Keyed by project **number** — using the project id yields
  `400 … does not exist` and the grant silently never applies.

---

## 11. Open items

1. Per-agent attribution for Power Automate connectors (agent → flow → connector).
2. Tenant-scope the Secret Manager ids — `connectorSecretId()` has no `appUserId`, so two
   customers sharing a project, or one customer with two Jira sites, collide.
3. Validate-on-save probe for every connector, so "✓ Saved" means "works", not "stored".
4. Connector health state (`ok / needs_reconsent / invalid / untested`) surfaced in the UI.
5. Generic OAuth consent layer (provider table, callback, refresh-token rotation,
   Atlassian `cloudId` base-URL switch) — lets customers click **Connect** instead of
   pasting credentials, once CloudFuze registers an app per provider.
6. Decide the fate of `/connectors` (recommendation: demote to advanced, §4).
