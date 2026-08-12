# Production Hardening Plan — CloudFuze Studio Migrate

Status as of **2026-08-10**. This is the working list behind the push to make migrated
agents production-grade: every connector provably working, every failure visible, and no
customer's credentials reachable by another.

The organising principle, and the reason most items exist:

> **A best-effort call that degrades output MUST record a FidelityNote.**
> A 200 is not an answer. `deployed=true` is not `works=true`.

> **Superseded in part, 2026-08-12.** Stream C's connector items (#11 OpenAPI spike, #12
> typed per-operation tools, #14 conformance probes, #15 support tiers) are now carried by
> [connector-transform-plan.md](connector-transform-plan.md), which went through a full
> CEO + Eng review and has a sequenced, milestone-gated order. Stream A's identity items
> (#8, #19, #23, #25) appear there as steps 1, 10 and 11 — **Stream A still moves first**,
> as this document has always said. Where the two disagree, the reviewed plan wins. Do not
> work Stream C items from this file.

That invariant applies to this document too. **This file states intent; it does not state
proof.** What has actually been observed to work — with the command and the output line —
lives in [verification-ledger.md](verification-ledger.md). Before citing anything here as
working, check its grade there. As of 2026-08-11, **none of the 15 code changes in flight
is grade P**.

Four separate bugs have already had exactly that shape — the swallowed `updateMask`, the
`ADK_STAGING_BUCKET` 403, layout parsing, and a tool call that never happened. Each one
shipped an agent that looked migrated and was not.

---

## Done (2026-08-10)

Seven items landed. Both typechecks clean, `adk_deploy.py` parses.
**None of it is proven against live infrastructure yet** — the ADK callback work in
particular needs a redeploy to confirm the installed `google-adk` accepts
`global_instruction` and `after_tool_callback` (there is a `TypeError` fallback, itself
untested).

### 1. Secret ids scoped by `appUserId`
`connectorSecretId()` produced `studio-enterprise-{scope}-{field}` with no tenant
segment. Two customers sharing one Google project collided: B's save overwrote A's Jira
token, and A's deployed agent then read B's credential. Isolation rested entirely on
every customer having their own project — an assumption nothing enforced.

Ids now carry the tenant. Reads resolve through the durable record
(`db/repos/connectorCredentials`) rather than recomputing, so credentials saved before
scoping keep backing the agents already deployed on them. No redeploy, no migration
script.

### 2. Per-secret IAM instead of project-wide
The documented prerequisite was project-wide `roles/secretmanager.secretAccessor` for the
Reasoning Engine service agent — one identity shared by every engine in the project, so
any deployed agent could read every secret there. Deployment now grants
`secretAccessor` on exactly the secrets that agent's tools resolve. Best-effort: if our SA
cannot set the policy, a `needs-review` note says so instead of a green deploy with tools
that 403 at inference.

### 3. Credentials no longer re-asked or re-versioned on every save
Three stacked causes: the client posted every field on every save; `credentialAlreadySupplied`
was only a banner so inputs still rendered as required; and `upsertSecret` always added a
version without comparing. Result — admins retyped credentials the product already held,
and each retype wrote another billed version of an identical secret.

Now: satisfied fields render `✓ Already stored` with a **Replace** control, the client
posts only what changed, and the server skips `addVersion` when the value is unchanged.

### 4. Secret lifecycle
Labels (`managed_by` / `app_user` / `connector`) so a tenant's credentials can be
enumerated at all; `pruneSecretVersions` keeping two and destroying older ones;
`deleteSecret`; and `DELETE /connector-credentials?purge=true` which skips any secret a
sibling connector still depends on — one Atlassian token backs both Confluence and Jira,
and purging Jira must not break a running Confluence agent.

### 5. Validate-on-save
`services/connectorValidator.ts` makes a real API call after storing. Critically it
separates **`invalid_credentials`** (wrong value, retype it) from **`permission_denied`**
(right value, an admin must consent) — collapsing both into "failed" sends admins to
regenerate a token that was never the problem. A minted token proves nothing on its own:
Entra issues one for an app with no application permissions consented, and every Graph
call then 403s.

Connectors outside the validated set return `unverified`, never a fake ✓.
UI shows **✓ Verified** / **⚠ Saved, but not working** / **• Saved (not tested)**.

### 9. Tool-name and citation contract enforced via ADK callbacks
`after_tool_callback` records real tool calls into session state, on the root **and** on
topic sub-agents — once the root transfers to a topic, the topic is what calls the tools,
so those calls were previously invisible. `global_instruction` carries the naming rule and
the `[INDEXED]`/`[LIVE]` citation contract, which is what makes them reach sub-agents; the
root's own instruction never did, so a question routed to a topic silently escaped the
rules.

### 13. Fidelity note for unregistered connectors
`buildLiveConnectorSpecs` dropped unknown connectors with a server-log warning and nothing
else. The agent deployed green while missing a capability its Copilot original had. Now
reported per agent as `lost`, naming the operations the source used.

### Two bugs fixed in passing
- The Microsoft credential route recorded `session.geminiProject` while writing secrets to
  `effectiveGeminiProject`, so `/connector-requirements` counted them as unconfigured and
  every Microsoft connector re-asked for credentials whenever the destination override was
  active.
- Partial saves would have blanked the secret ids of untouched fields — the ids deployed
  agents resolve their credentials by.

---

## Open work, by stream

Five streams. **A** is the one with a live security consequence and should move first;
**B** is what makes "it migrated" mean something; **C** is the product unlock; **D** and
**E** are breadth and housekeeping.

| Stream | What it is | Items |
|--------|-----------|-------|
| **A — Identity & access** | Who the migrated agent acts as, and who can see what | #18, #19, #20 ✅, #21, #22, #23, #24, #25, #26, #8 |
| **B — Honest reporting** | Never ship an agent that looks migrated and is not | #6, #7 |
| **C — Connector coverage** | Turn 5 proven connectors into many | #11, #12, #14, #15, #17 |
| **D — Tool correctness** | Right answers, not just answers | #16 |
| **E — Housekeeping** | | #10 |

---

## Stream A — Identity & access

The stream that matters most, because its failure mode is a customer discovering that
everyone can read everyone's data.

### The two halves, and the one thing that does not work

A migrated agent reaches customer data by two separate routes, and **each needs its own
per-user mechanism**. Fixing one does nothing for the other:

| Route | What it is | Per-user mechanism | Status |
|-------|-----------|--------------------|--------|
| **Track B — live tools** | `jira_search`, `sharepoint_list_files`, ticket creation | Gemini Enterprise `authorizations` → end-user token in `tool_context.state["temp:<id>"]` | Confirmed available (200, empty list, IAM fine) |
| **Track A — indexed knowledge** | documents crawled into Discovery Engine data stores | ACL-aware ingestion (`aclEnabled: true`) + identity mapping, filtered by caller at query time | Confirmed to exist in this project — but only via Google's native connector, never ours |

**Rejected approach — admin token plus filtering.** The tempting shortcut is to call every
API with one admin credential, then narrow the results to the asking user. It fails in two
distinct ways and neither is fixable:

- *Filtering in the model* ("here is everything, only use Alex's part") is not an access
  control at all. Once data enters the context it is disclosed; an instruction not to use
  it is a request. This codebase has already watched a deployed agent ignore an explicit
  instruction not to name its internal tools.
- *Filtering in our tool code* means reimplementing every provider's permission model —
  Jira permission schemes and issue-level security, Confluence space permissions plus page
  restrictions plus inheritance, SharePoint broken inheritance and sharing links — each
  different, each changing under us. And it **fails open**: a bug shows the user more. A
  per-user token fails closed — a bug shows them less. That asymmetry is the whole
  argument. The obvious shortcut is also simply the wrong query: with an admin token
  "Alex's issues" degrades to `assignee = alex`, but Alex may be *permitted* to read ten
  thousand issues while assigned twelve.

Jira Cloud and Confluence Cloud have no supported admin impersonation for REST. Graph is a
partial exception (`/users/{id}/drive` under an app-only token) but that answers "what is
in Alex's drive", not "what is Alex allowed to see".

The correct use of an admin credential is the third one: crawl the documents **and their
permissions**, store the ACLs beside the content, and let the search engine filter by
identity at query time. Permission evaluation stays with the system that owns it. That is
exactly what `aclEnabled: true` does, and why the native connector matters.

One fact that makes all of this tractable: **Gemini Enterprise forwards the end user's
email address to the agent**, so identity is never the missing piece — only authority to
act as them.

### Order of execution

1. **#22 Pin `google-adk` below 1.17** — first, or the end-user token is not there to read.
2. **#18 Extract `connectionProperties.mode`** — done in `dataverse.ts`; recorded on
   `AgentToolIR.connectionAuthMode`.
3. **#24 Registry: per-connector OAuth capability** — which providers can be per-user at all.
4. **#19 Gate `Invoker` agents** — report and require acknowledgement while #23 is unbuilt.
5. **#23 End-user authorizations for live tools** — Track B's real fix. Blocked on #18 + #22 + #24.
6. **#25 ACL-preserving knowledge ingestion** — Track A's real fix. Blocked on the write-probe #26.
7. **#26 Write-probe: native Jira connector + one authorization end-to-end** — settles the
   last two unknowns; needs the customer's go-ahead because it creates resources.
8. **#21 Least-privilege the shared credential** — mitigation that stays useful afterwards.
9. **#8 ACL-loss gate** — the honest disclosure while #25 is unbuilt.

### Correctness — silent failure

**#6 Prove every wired connector individually in `verify.ts`** *(unblocked by #9)*
`verify.ts` records `toolSucceeded` per agent, so an agent with five connectors passes
when one works. Read the per-tool record the new `after_tool_callback` writes, force one
call per wired connector, and report per connector.

**#7 Make `verified` the only success signal the UI renders green**
The invariant at the top of this document, enforced. Stop rendering `created` / `deployed`
as green — only `MigrationResult.verified`. Every future silent failure then becomes a
visible red instead of a lie.

**#14 Conformance probe per registry connector**
28 of 34 registry entries have never made a live call — their `baseUrlTemplate`, `authKind`
and header templates are untested guesses. One real read call each against a sandbox,
runnable in CI. Also the gate that lets a connector move from best-effort to guaranteed.

**#15 Report connector support tier honestly per agent** *(blocked by #14)*
The report does not distinguish a live-verified connector from an untested generic one
from an unsupported one, and never surfaces the operation descriptions extracted from
Copilot — the source's own statement of what each operation does, currently used only in a
prompt.

### Access and identity

**#8 Gate migration on explicit ACL-loss acknowledgement**
`aclEnabled` is immutable on a data store, so lost source permissions cannot be retrofitted
without recreating and re-indexing everything. Combined with ADK registering agents
org-wide `ALL_USERS`, a SharePoint folder restricted to Finance becomes readable by anyone
who can reach the agent. Belongs on the connector screen before migration, with
acknowledgement — not as a note discovered afterwards.

**#18 Detect whether a Copilot connector used end-user or shared auth**
`dataverse.ts:583` reads `connectionReference` only to derive the connector id and discards
the auth mode. We cannot currently tell an agent that authenticated as each signed-in user
from one using a shared maker connection — so we cannot say how many agents are affected by
#19, and cannot decide anything without that number.

**#19 Gate migration when the source used personal connections** *(blocked by #18)*
An agent whose connectors authenticated as the signed-in user migrates onto a single
app-only service credential, so every end user inherits everything that identity can see.
This is privilege escalation, not a fidelity gap. Requires explicit acknowledgement.

**#20 Spike: can Gemini Enterprise authorizations give tools the end user's identity** ✅
**Answered yes** — see Q2 and Q3 under Research findings. The resource exists, is
documented, and is reachable in our destination project with current IAM.

**#21 Scope shared connector credentials to least privilege**
While one identity serves every end user, bound what it can reach. SharePoint and OneDrive
tools are already folder-scoped; extend to Jira projects and Confluence spaces. Mitigation,
not a substitute for per-user auth — and it stays worth having afterwards, because a
per-user token still should not reach beyond what the agent legitimately needs.

**#22 Pin `google-adk` and `aiplatform` in the deployment requirements**
`adk_deploy.py:1189` declares `["google-cloud-aiplatform[agent_engines,adk]", "google-adk"]`
with no version bounds, so every deployment installs whatever is latest that day. Two
identical migrations a week apart can produce differently-behaving agents, and an upstream
regression lands in customer agents with no change on our side. Immediately relevant: ADK
**1.17.0 removed Gemini Enterprise authorization tokens from `ToolContext.state`**
(`google/adk-python#3274`, still open), so #23 requires 1.16.x until it is fixed. Pin both,
and record why the ceiling exists so nobody raises it without reading the issue.

**#23 Per-user live tools via end-user authorizations** *(blocked by #18, #22, #24)*
Track B's real fix. Create an authorization resource per provider per project
(`serverSideOauth2`: `clientId`, `clientSecret`, `authorizationUri`, `tokenUri`; redirect is
Google's own `vertexaisearch.cloud.google.com/static/oauth/oauth.html`), attach it at
registration via `authorizationConfig.toolAuthorizations`, and have generated tools read the
end user's token from `tool_context.state["temp:<authorization-id>"]` instead of a Secret
Manager value.

Design points that are easy to get wrong:
- **Mixed-mode agents are normal.** One agent can hold an `invoker` tool and a `maker` tool
  at once, so the credential source belongs on the per-tool spec, not as a per-agent switch.
- **Consent is per authorization resource.** Three `invoker` providers means three
  *Authorise* clicks before the agent is useful. There is no bundling. Worth knowing before
  a demo.
- Shared-connection agents keep the existing app-only path completely unchanged.

**#24 Registry: record each connector's OAuth capability** *(prerequisite for #23)*
Per-user auth is only possible where the provider supports OAuth **authorization-code**;
where it does not, no mechanism at any layer can supply a per-user identity. Add to each
registry entry whether it supports auth-code, plus `authorizationUri`, `tokenUri` and the
scopes. Roughly how the 34 entries land:

| Category | Per-user possible | Notes |
|----------|------------------|-------|
| Atlassian, HubSpot, Salesforce, ServiceNow, Slack, Box, Dropbox, GitHub, Zendesk, Google Drive | yes | straightforward auth-code |
| Microsoft Graph (Teams, SharePoint, OneDrive, O365) | yes, but | we use `client_credentials` today; delegated OAuth is a different app configuration and a different consent, not a flag |
| SendGrid, Twilio, Stripe, Mailchimp, static-API-key connectors | **no** | the token *is* the identity; there is no user to ask about |
| `shared_http` | unknown | whatever the customer's endpoint supports |
| MCP servers | separate | MCP carries its own auth model |

**#25 ACL-preserving knowledge ingestion** *(Track A's per-user fix; blocked by #26)*
Every data store our pipeline produces is `aclEnabled: false`, and the flag is immutable —
so source permissions cannot be retrofitted onto an existing store without recreating and
re-indexing everything. Proven side by side in `studio-enterprise-migration`:
of 47 stores, **3 are `aclEnabled: true`** — all three named after a native connector
collection — and the **44** our pipeline produced are all `false`. Exact ids and the
command that produced them: [verification-ledger.md §1.3](verification-ledger.md).

Our own crawler cannot reach `true`: it would mean extracting each item's ACL, mapping
source principals to Google identities, and maintaining that mapping — which is the native
connector's whole job, complete with its `identityScheduleConfig.refreshInterval` of 86400s.
The realistic options are to adopt the native connector for the providers where the
customer can complete its auth (Atlassian can, SharePoint cannot — it demands a
certificate-minted token, `appidacr: 2`, and customers can only give us a client secret),
or to accept the loss and disclose it under #8.

**#26 Write-probe: native Jira connector and one authorization, end to end**
The last two unknowns both need resources created, so this needs the customer's explicit
go-ahead. Both steps are reversible (delete the resource, delete the collection) and neither
touches the two live migrated agents.

1. Create one authorization resource and attach it to a throwaway agent — proves the
   end-user token actually arrives in `tool_context.state` at inference, which no read-only
   probe can show. Needs an Atlassian OAuth client id/secret.
2. Create a native Jira connector on a test collection — settles whether Atlassian
   ingestion really produces `aclEnabled: true`, and whether its Actions
   (`create_jira_issue`, `update_jira_issue`) are invocable by a **registered agent** or are
   limited to the built-in assistant. The assistant resource exposes no `actionList` or
   `toolList`, so nothing observable answers this today. If Actions are assistant-only, the
   native path covers knowledge only and all live tools stay ours.

### Connector coverage

**#11 Spike: can we read Power Platform connector OpenAPI** — highest-leverage unknown
Copilot Studio holds each connector's OpenAPI: every operation's path, method, typed
parameters, required fields, response shape. We take only the prose description
(`knowledgeConnectorScan.ts:201` → `adk_deploy.py:124`) and drop the contract it came from.
That is why the model cannot form correct calls and why Jira needed hand-written tools —
no docstring sentence teaches it that `/rest/api/3/search` is dead, `/search/jql` replaced
it, and unbounded JQL is rejected.

Check the Dataverse `connector` table's `openapidefinition` column for custom connectors,
and the Power Apps connector API / `microsoft/PowerPlatformConnectors` for certified ones.

**#12 Generate typed per-operation tools from OpenAPI** *(blocked by #11)*
Replace the generic `call_<kind>_api` with one typed `FunctionTool` per operation, docstring
taken from Copilot's own operation description. This is what promotes the 28 best-effort
connectors to working, and the only path to hundreds of connectors without hand-writing
each.

**#16 Writes, rate limits and pagination**
(a) Every purpose-built tool is read-only — a Copilot agent that *creates* a Jira issue
migrates to one that cannot, with nothing reported. (b) `_mint_token` caches tokens but API
calls have no 429/503 backoff, so a rate limit mid-conversation surfaces as a wrong answer.
(c) Tools return only the first page, so counting questions get confidently wrong numbers.

**#17 Teams to guaranteed tier**
Teams rides the `ms_graph` credential group, so credential and auth work is done — only the
purpose-built tools are missing. Cheapest addition to the guaranteed set.

### Housekeeping

**#10 Push the local commits on `business`**
22 commits plus the seven items above are local-only. Also decide whether
`server/src/spikes/_diag_connectors_by_agent.ts` ships or is dropped.

---

## Research findings — 2026-08-10

Both open research questions are now answered. Both answers change the plan.

### Q1 — Does Dataverse record per-user vs shared connector auth? **Yes.**

Found by `server/src/spikes/_diag_connection_auth_mode.ts` (read-only) against
`orga243378d.crm.dynamics.com`. The discriminator is in the **action payload**, not on the
connection reference:

```yaml
connectionReference: crf37_Confluenceagent.shared_confluence.cbc262ecb6fe401294af380b08d029d6
connectionProperties:
  mode: Invoker
```

- `mode: Invoker` → the action runs as the **signed-in end user**
- `mode: maker` (or absent) → the maker's single shared connection

Ruled out along the way: `connectionreferences` has no auth-mode column (the
auth-looking ones are Dataverse audit fields — `_owninguser_value`,
`_createdonbehalfby_value`), and `connectionid` is populated for design-time-bound
references, so its emptiness is not a reliable signal. Every bot in this environment
reports `authenticationmode=2` / `authenticationtrigger=1` uniformly, so the bot-level
setting does not discriminate either.

**The uncomfortable part:** both agents in this tenant that use connector actions —
`Confluence_agent` and `Dev Help Desk Agent` — are `mode: Invoker`. The real customer
agents we have been migrating are **per-user**, and we have been collapsing them onto one
shared service credential. This is not a hypothetical.

### Q2 — Can Gemini Enterprise pass the end user's identity to agent tools? **Yes.**

The mechanism exists and is documented:

1. Create an authorization resource:
   `POST https://{LOC}-discoveryengine.googleapis.com/v1alpha/projects/{PROJECT_NUMBER}/locations/{LOC}/authorizations?authorizationId={ID}`
   with `serverSideOauth2` → `clientId`, `clientSecret`, `authorizationUri`, `tokenUri`.
   The redirect URI is Google's own
   `https://vertexaisearch.cloud.google.com/static/oauth/oauth.html`.
2. Attach at agent registration:
   `authorizationConfig.toolAuthorizations: ["projects/{N}/locations/global/authorizations/{ID}"]`.
   Agent Engine accepts multiple; A2A only the first.
3. On the user's first interaction Gemini Enterprise shows an **Authorise** button, runs
   the OAuth consent, and forwards the resulting access token to the agent, which reads it
   from `tool_context.state` under the key `temp:<authorization-id>`.

**Blocking caveat:** ADK Python **1.17.0 removed those tokens from `ToolContext.state`**
(`google/adk-python#3274` — still open, no maintainer fix, workaround is to stay on
1.16.0). Related: `#4712` and `#4553` report that `GoogleAPIToolset` and
`ApplicationIntegrationToolset` never pick the token up even when present. Our tools are
hand-written, so those two do not block us — but the state-key regression does.

This also exposed an independent problem: `adk_deploy.py:1189` declares
`["google-cloud-aiplatform[agent_engines,adk]", "google-adk"]` with **no version bounds**,
so every deployment installs whatever is latest that day. Two identical migrations a week
apart can behave differently, and an upstream regression reaches customer agents with no
change on our side. Tracked as #22.

### Q3 — Live probe of the destination project (2026-08-10)

`server/src/spikes/_probe_native_connectors_and_auth.ts`, read-only, against
`studio-enterprise-migration` / engine `gemini-enterprise-17847887_1784788734248`.

**Per-user OAuth is available and unblocked.** `GET .../locations/global/authorizations`
returns **200 with an empty list** — the mechanism behind
`authorizationConfig.toolAuthorizations` is reachable with our current IAM, and simply has
nothing configured yet. The per-user tool work is a code problem, not a permissions one.

**Native connectors preserve ACLs; ours do not — proven in this project.** Six native
`dataConnector`s already exist here (`sharepoint` ×3, `sharepoint_federated_search` ×2,
`google_drive`), two carrying `identityScheduleConfig.refreshInterval: 86400s` — the
identity-mapping refresh. Of the 47 data stores in `default_collection`, exactly **three**
are `aclEnabled: true` — `connectortest_1785961359928_file`,
`sharepointconnectortest_1786023277930_file`, and
`erik-googledrive_1786356561493_google_drive` — and each is named
`<native connector collection id>_<entity>`. The **44** our pipeline produced are all
`aclEnabled: false`. This is no longer a documentation claim; both behaviours are visible
side by side in the same project.

One caveat worth keeping honest: the link from those three stores to the native connectors
is a **name match**, not a provenance field the API returns. It is strong — nothing else
here produces that id shape — but it is an inference. Graded as such in
[verification-ledger.md §1.3](verification-ledger.md).

No `jira` or `confluence` native connector exists here, so the Atlassian path specifically
is still untested.

**Actions remain unproven.** The assistant resource exposes only
`name, displayName, webGroundingType, createTime, updateTime` — no `actionList`,
`toolList` or equivalent. Nothing observable ties native connector Actions to a
*registered agent* rather than the built-in assistant, so whether a migrated ADK agent can
invoke `create_jira_issue` is still unknown. Settling it needs a write: create a native
Jira connector and attempt to reference its actions from an agent.

All 27 registered agents report no `authorizationConfig`, as expected — nothing has used
it yet. (Several are duplicates from repeated test runs and are billing; worth a cleanup
pass.)

### What this changes

The shape of the fix is now known rather than guessed:

- Extraction reads `connectionProperties.mode` and records it on `AgentIR` (#18).
- `Invoker` agents get an authorization resource plus `authorizationConfig` at
  registration, and their tools read `temp:<auth-id>` instead of a Secret Manager value.
- Shared-connection agents keep the current app-only path unchanged.
- Pin `google-adk<1.17` before any of it, or the token will not be there to read (#22).

The migration is therefore possible at full fidelity for **live tools** — which was the open
question — but only where the provider supports OAuth authorization-code with a client we
can configure. Atlassian and HubSpot do; a connector authenticating solely by static API
token cannot be made per-user by any mechanism, and that limit is real regardless of what we
build (#24).

**Indexed knowledge is a separate problem with a separate fix.** Per-user tool auth does
nothing for documents already crawled into a data store: those stay `aclEnabled: false`, and
the flag is immutable. An `Invoker` agent with SharePoint knowledge is still over-sharing on
the indexed side even after #23 ships. That half is #25, and the only known mechanism for it
is ACL-aware ingestion via a native connector.

---

## Connector support tiers — the honest claim

Registry: 37 entries = 3 credential groups + **34 connectors**. Copilot Studio can use
roughly 1,400 Power Platform connectors, so this is ~2% by count — but coverage is not flat.

| Tier | Connectors | Status |
|------|-----------|--------|
| **Guaranteed** | SharePoint, OneDrive, Confluence, Jira, HubSpot (+ Teams once #17 lands) | Purpose-built tools, live-verified against real data |
| **Best-effort** | 28 others (Salesforce, ServiceNow, Zendesk, Slack, Stripe, GitHub, Notion, Asana…) | Registry entry + generic REST tool. Architecturally fine, **never tested against a live tenant** |
| **Unsupported** | everything else | Now reported as `lost` (#13) rather than dropped silently |

Adding a connector is data, not code — ~15 lines — *if* it fits the envelope: REST + JSON,
one of five `authKind`s, URL expressible as a template, and an API the model can drive from
a docstring. Outside it: SOAP/XML/GraphQL, signed requests (AWS SigV4, per-request HMAC),
and anything Jira-shaped where the generic tool is not enough.

OAuth authorization-code used to sit on that exclusion list because we had no consent flow.
Gemini Enterprise `authorizations` supplies one (#23), so auth-code providers move from
"cannot support" to "supported, and supportable *per user*" — which is a strictly better
outcome than the shared-credential path they would otherwise have had.

**Defensible claim today:** "any agent, with the five connectors we have proven, plus
best-effort on 28 more, plus generic HTTP."
**Not defensible:** "any connector."

---

## Suggested order

Research questions #18 and #20 are answered, so the order below starts from what is now
buildable rather than from what needed deciding.

1. **#26** — the write-probe. Needs the customer's go-ahead and an Atlassian OAuth client.
   It gates #25 and confirms #23 end to end, so everything in Stream A is cheaper after it.
2. **#22 → #24 → #19** — cheap, code-only, no live dependency. Pin the ADK version, record
   which connectors can be per-user at all, then gate `Invoker` agents honestly in the
   meantime.
3. **#23** — per-user live tools. The single biggest correctness win available.
4. **#6, #7** — close the last silent-success holes.
5. **#25 or #8** — depending on what #26 returns: build ACL-preserving ingestion if the
   native Atlassian path works, otherwise disclose the loss and move on.
6. **#11 → #12** — the connector coverage unlock.
7. **#21, #14 → #15, #16, #17** — least privilege, coverage breadth, tool correctness.
8. **#10** — push, whenever.

### Blocked on a decision, not on engineering

- **#26** creates two resources in the customer project. Reversible, does not touch the two
  live migrated agents, but needs an explicit yes.
- **Whose OAuth app?** Google ships no first-party app, unlike Microsoft, which is why
  Copilot's `Invoker` mode was frictionless and this will not be. Either CloudFuze registers
  one app per provider (zero customer setup, but our app sits in every customer's data path
  and some regulated tenants refuse third-party OAuth apps), or each customer registers
  their own (nothing of ours in their path, but real per-customer setup — the same friction
  that made Google's native SharePoint connector unusable for us). Current steer from the
  customer is to lean on the platform's own connector apps where possible; #26 establishes
  whether that is actually available.
- **What to do when per-user is impossible** (static-token provider, or no OAuth app
  configured): migrate with acknowledgement, refuse the agent, or drop just the tools.
  Undecided.
