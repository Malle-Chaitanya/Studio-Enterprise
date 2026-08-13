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

1. ~~Per-agent attribution for Power Automate connectors~~ — see §12 for Google Drive
   specifically; the connection-reference-level owner is fetchable (§12.2), though the
   underlying OAuth identity is not.
2. Tenant-scope the Secret Manager ids — `connectorSecretId()` has no `appUserId`, so two
   customers sharing a project, or one customer with two Jira sites, collide. **Design
   proposed in §12.4** — scope per identity profile, not just per connector type.
3. Validate-on-save probe for every connector, so "✓ Saved" means "works", not "stored".
4. Connector health state (`ok / needs_reconsent / invalid / untested`) surfaced in the UI.
5. Generic OAuth consent layer (provider table, callback, refresh-token rotation,
   Atlassian `cloudId` base-URL switch) — lets customers click **Connect** instead of
   pasting credentials, once CloudFuze registers an app per provider.
6. Decide the fate of `/connectors` (recommendation: demote to advanced, §4).
7. ~~Build the identity-profile UI + orchestrator wiring described in §12~~ — superseded,
   see §12: shipped as a single impersonate_email per migration instead, via the
   existing generic connector-credential mechanism (no new UI, no orchestrator.ts change).

---

## 12. Google Drive — identity model

**Date added**: 2026-08-12. **Status**: implemented 2026-08-13. Two separate decisions
below were each revised — one twice — the same day. Read the "final decision" in each,
not just the first description; the numbering here is what every code comment referring
to "§12.x" means, kept stable rather than renumbered again.

### 12.1 The core problem

A customer's Copilot Studio estate has many agents, and each agent's Google Drive
connector may have been authorized against a DIFFERENT Google account — a shared team
Drive, or an individual employee's own personal Drive. Two real patterns exist, and a
real customer estate has a mix of both:

- **Pattern 1 (shared/team Drive)**: one designated identity is correct for every agent
  that uses it — same shape as Confluence/Jira's single shared credential.
- **Pattern 2 (personal Drive)**: each agent needs to match the SPECIFIC person, or the
  migrated agent is reading the wrong person's files. A single migration-wide identity
  is actively wrong here.

### 12.2 What's fetchable, verified against official docs and live tenants — not assumed

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Which Google account authorized the connector? | **Not fetchable.** Lives on the live Connection object in Power Automate's "API hub," reachable only via delegated (interactive) auth — CS_GE's extraction is app-only `client_credentials` and cannot reach it. | [Programmability and Extensibility — Authentication, Power Platform](https://learn.microsoft.com/en-us/power-platform/admin/programmability-authentication-v2): *"Power Platform API uses delegated permissions only at this time."* |
| 2 | Who created/owns the specific connector reference? | **Fetchable**, app-only. `connectionreference` has its OWN `CreatedBy`/`ModifiedBy`/`OwnerId`, independent of the parent `bot`'s owner. Verified live 2026-08-13 against `orga243378d.crm.dynamics.com`: resolved correctly to `erik@filefuze.co` for real SharePoint/Office365 connection references. | [Connection Reference table reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/connectionreference); `services/thirdPartyConnectorScan.ts`'s `getConnectionReferenceOwner` |
| 3 | Can one connection reference be attributed to one specific agent? | **Not reliably**, via app-only auth — no direct, cheap relationship was found between a `connectionreference` and the one bot/topic that uses it. Suggestions are therefore scoped to the whole ENVIRONMENT, never claimed as agent-precise. | `services/thirdPartyConnectorScan.ts`'s `findConnectionReferenceLogicalNames` |

**Net: no fact, but a testable hint** — the connection reference's owner is a Microsoft
identity, not the Google account it authenticated to. It must be confirmed by a human,
never trusted outright.

### 12.3 Why not native Gemini Enterprise Actions instead

Investigated and rejected — kept here so it isn't re-litigated. Native Actions
(Copy/Create Folder/Download/Upload) live inside Agent Designer / the built-in assistant;
unreachable from the ADK/Reasoning-Engine agents this pipeline creates. Native
Federated search is confirmed blocked for headless callers: `403 "Search using service
account credentials is not supported for workspace datastores."` Even ignoring both,
native Actions cover only 4 of the source's 12 actions — the custom Track B tool
(`connector_tools/google_drive.py`, all 12 actions, live-verified 2026-08-11) is strictly
better and already proven; native Actions would only add a second, more complex auth
model on top for zero net gain.

### 12.4 The shared-key decision: customer's OWN service account, not CloudFuze's

`shared_googledrive.credentials` in `registry.ts` declares `service_account_json` —
shared across the WHOLE migration, since one key can DWD-impersonate anyone in the
domain, one time at a time. This went through two revisions the same day:

- **First cut (superseded within hours)**: one migration-wide `impersonate_email` field,
  with `service_account_json` marked `internal: true` and auto-filled server-side from
  CloudFuze's OWN shared SA key (`internalFieldValue()`, `ownServiceAccountKeyJson()`).
  Simple, matched Jira/SharePoint's one-field shape exactly. Wrong on two counts, both
  raised directly by the team rather than found in testing: (1) the deployed agent's
  live Drive tool depends on CloudFuze's shared key FOREVER after migration — a customer
  revoking DWD for CloudFuze's client ID once "the migration tool" looks done (a
  reasonable thing to do) breaks Drive on an agent they already rely on daily; (2) one
  migration-wide identity cannot represent Pattern 2 at all (§12.1) — every agent got the
  exact same identity regardless of whose Drive it actually needed.
- **Final decision**: `service_account_json` is customer-visible, with copy asking them
  to create the SA in THEIR OWN Google Cloud project (not CloudFuze's) and authorize
  DWD for ITS Client ID. Zero Python changes required —
  `connector_tools/google_drive.py`'s `_mint_token` does
  `service_account.Credentials.from_service_account_info(key).with_subject(email)`,
  which never cared whose key it was handed; this was proven true empirically (the very
  first live Drive test in this project used CloudFuze's key with the identical code
  path). The `internal` field concept, `internalFieldValue()`, and
  `ownServiceAccountKeyJson()` were removed outright as unused rather than left dormant,
  since Drive was their only caller.

### 12.5 The per-agent identity decision: Erik's agent → Erik's Drive, Alex's → Alex's

Built, then deleted in favor of "treat Drive exactly like Jira" (one shared
`impersonate_email`, zero new UI), then rebuilt the same day once the team pointed out
the one-shared-identity shape cannot serve Pattern 2 (§12.1) at all. What shipped:

- **`db/repos/agentConnectorIdentity.ts`**: one record per (customer, source agent,
  connector) — `{impersonateEmail, status: 'confirmed' | 'suggested' | 'needs-review'}`.
  `status` only ever becomes `'confirmed'` via an explicit admin action
  (`POST /api/migrate/drive-identities`), never set by the system on its own initiative.
- **Suggestion, honestly scoped**: `services/driveIdentityResolution.ts`'s
  `suggestEnvironmentDriveIdentity` reads every Drive connection reference in the WHOLE
  environment (§12.2 row 3), resolves each owner to a Google identity via the EXISTING
  `identityMap.ts` (not a new system), and suggests something ONLY when every one
  resolves to the SAME Google identity. Multiple distinct identities in one environment
  → no suggestion at all, rather than guessing among them.
- **UI**: `ConnectorConfig.tsx`'s `DriveIdentitySection`, rendered directly under the
  shared credential card — one row per selected Drive-using agent, pre-filled with a
  suggestion when one exists, always requiring an explicit Confirm click before it counts.
- **Deploy-time wiring** (`orchestrator.ts`, immediately after `scopedConnectors` is
  built, before every later place that reads it — the secret-sync loop, the deploy call,
  and the per-tool fidelity check): an agent with NO confirmed identity gets Drive
  dropped from its tool list entirely, never silently pointed at a guess, with a
  `needs-review` fidelity note explaining exactly why. A confirmed identity's email is
  written to a secret scoped by AGENT (`shared_googledrive:agent-<sourceId>` — the same
  synthetic-connectorId trick as the removed `connectorProfileScope`), so two agents
  never collide on one secret slot.
- **What is genuinely NOT solved**: WHICH agents use Drive at all is still detected at
  the whole-environment level pre-migration (§12.2 row 3 — no cheap, reliable per-agent
  attribution exists before full IR extraction). `DriveIdentitySection` shows the picker
  for every selected agent in a Drive-detected environment, not only the ones precisely
  confirmed to use it. Harmless in practice (an unused identity assignment on an agent
  that turns out not to need one costs nothing), but not fully precise — a genuinely
  agent-precise version would need to wait until after Phase 1 extraction, when
  `agentConnectorIds(ir)` knows for certain.
- The `impersonate_email` domain-ownership check (`routes/migrate.ts`,
  `impersonation_domain_mismatch`) applies on BOTH this per-agent save route and the
  shared-key path (§12.4) — kept even though a customer-owned SA already makes
  cross-customer impersonation structurally impossible, as a cheap, harmless sanity
  check against typos (e.g. a former employee's personal Gmail).
