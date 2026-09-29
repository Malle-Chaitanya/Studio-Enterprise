# Dynamic Connectors — Research & Approach Decision

**Date**: 2026-09-22
**Status**: Approach decided; implementation in progress (150/281 connectors live)
**Scope**: how CloudFuze Studio Migrate (CS_GE) supports the connectors a Copilot Studio
agent uses — Dropbox, Salesforce, SharePoint, Zendesk, and 280+ others — when it migrates
that agent to Google Gemini Enterprise, without requiring new backend code for every
connector a customer happens to use.

---

## 1. Problem Statement — Customer Perspective

A customer's Copilot Studio agent is rarely just instructions and knowledge. Most real
agents also *do* things — they look up a record in Salesforce, list files in a SharePoint
folder, create a ticket in Zendesk, send a message in Teams. Each of these is powered by a
**connector**: a pre-built integration to an external system. Microsoft ships and
maintains **over 280 of these connectors** today, and adds more on an ongoing basis.

When CloudFuze migrates that agent to Gemini Enterprise, every one of those connector
actions has to keep working — the same lookups, the same actions, against the same real
systems — or the migrated agent is a worse version of the one the customer already had.

### Why this is hard to do by hand

The obvious way to support a connector is to write dedicated backend code for it: a
developer studies that one connector's API, hand-codes how to call it, how to
authenticate to it, and what each of its actions needs. That works, but it does not scale,
for reasons that are visible the moment a real customer base is involved rather than a
handful of pilot accounts:

- **The number of connectors a customer base touches is large and unpredictable.** No two
  customers use the same combination of connectors. A migration tool that only "knows"
  the connectors an engineer has personally sat down and coded will keep running into
  ones it doesn't — and every one of those becomes a support ticket or a blocked
  migration, not a five-minute config change.
- **A connector's own definition changes over time, and nobody tells us when.** Microsoft
  (and the underlying vendor) can add a new operation, remove a deprecated one, rename a
  parameter, or change what authentication it expects — all without any notice to us.
  Hand-written code has no way to know this happened. It keeps calling the connector the
  old way until a real customer's agent breaks in production and someone traces it back.
- **Hardcoded implementations quietly go stale.** The moment the code is written, it
  starts drifting away from the connector's real, current shape. There is no mechanism
  that re-checks it, so the gap between "what we coded" and "what the connector actually
  is today" only grows, silently, until it causes a real failure.
- **Onboarding a brand-new connector becomes an engineering project, not a data update.**
  Every unfamiliar connector a customer's agent uses today means: file a ticket, wait for
  engineering capacity, write and review new code, ship a release — before that one
  customer's migration can even complete. That is a slow, expensive, and completely
  avoidable bottleneck if the connector's own definition can just be *read* instead of
  *reimplemented*.

### The impact on the customer, concretely

- **Reliability** — a connector's real API moves; hand-written code doesn't. Silent
  breakage in production is a worse experience than an honest "not supported yet."
- **Maintenance cost** — every hand-coded connector is a permanent piece of code someone
  has to keep correct, forever, across every future change Microsoft or the vendor makes.
- **Migration accuracy** — if the implementation is stale, the migrated agent may call the
  wrong operation, send the wrong parameters, or authenticate the wrong way — and look
  "migrated" while quietly not working.
- **Support effort** — every one of these failures surfaces as a customer-reported bug
  rather than something caught and reported honestly at migration time.
- **Time to onboard a new connector** — with hand-written code, this is measured in
  engineering sprints. It should be measured in minutes.

**This is exactly why Dynamic Connectors are needed**: a way for CloudFuze Studio Migrate
to support any connector a customer's agent uses — including ones nobody at CloudFuze has
seen before — by reading that connector's own real, current definition, rather than by a
developer re-implementing it by hand every time.

---

## 2. Research — What We Investigated

We evaluated two fundamentally different ways to make connector support dynamic.

---

### Approach 1 — Google Integration Connectors

**What it is.** Integration Connectors is a Google Cloud product (part of the Application
Integration platform) that ships Google's own pre-built catalog of connectors to
third-party and enterprise systems — Salesforce, ServiceNow, SAP, databases, and others.
It is designed to let an application (including a Vertex AI / Gemini agent, via the
`ApplicationIntegrationToolset` in Google's Agent Development Kit) call these systems
without the calling application hand-coding each integration itself.

**How it works, at a high level.** A customer (or CloudFuze, on the customer's behalf)
provisions Application Integration in the customer's own GCP project, then creates a
**Connection** for each system the agent needs to reach — supplying that system's
credentials to Google's managed connector. Once a connection exists, an agent can be
wired to call it as a tool, and Google's own infrastructure handles the actual API call,
authentication refresh, and (for many connectors) the available operations.

**How connector definitions, auth, and operations would be handled.** Google maintains
its own definitions for each connector in its catalog — separate from, and not derived
from, Microsoft's Copilot Studio connector definitions. Authentication is configured per
connection (API key, OAuth, service account, etc., depending on what that connector
supports), and the set of callable operations is whatever Google's own connector exposes
— not necessarily a 1:1 match with what the *source* Copilot Studio connector exposed.

**What the architecture would have looked like if adopted:**

```
Customer's Copilot agent uses connector X
        │
        ▼
CloudFuze detects connector X during migration
        │
        ▼
Provision Application Integration + Integration Connectors in customer's GCP project
        │
        ▼
Create a Connection for connector X (customer supplies credentials again, to Google)
        │
        ▼
Wire the migrated Gemini agent's tool to call that Connection
        │
        ▼
Google's managed layer makes the actual API call on the agent's behalf
```

**Dependencies on Google Cloud services.** Requires Application Integration to be
provisioned (regionally) in the customer's project, plus Integration Connectors itself —
both separate, separately billed GCP products, on top of Gemini Enterprise/Discovery
Engine which the migration already depends on.

**Operational considerations.** The customer (or CloudFuze on their behalf) must
provision, configure, and maintain this second product indefinitely — it does not stop
being a dependency after the migration completes; the migrated agent keeps needing it to
function. Any connector not in Google's own catalog still needs a custom connector built
inside Integration Connectors — the "unknown connector" problem is not eliminated, only
relocated into Google's tooling.

**Advantages:**
- Google maintains and hosts the connector implementations, not CloudFuze.
- Reasonably broad catalog of common enterprise systems out of the box.
- Managed authentication refresh for supported auth types.

**Limitations:**
- A **separate, additional GCP product** the customer must provision and pay for,
  indefinitely, purely to keep a migrated agent's connectors working.
- **Does not remove the per-connector, per-customer configuration work** — every
  connection still has to be set up individually; it moves that work from our system into
  Google's console rather than eliminating it.
- Google's connector catalog and operation set is **independent of Microsoft's own
  connector definitions** — there is no guarantee it matches what the *source* Copilot
  Studio agent actually used, operation-for-operation.
- Introduces a **permanent operational dependency** on a second product the customer must
  keep healthy, separate from Gemini Enterprise itself.

**Cost / product dependency.** Both Application Integration and Integration Connectors
carry their own GCP pricing, on top of whatever the customer already pays for Gemini
Enterprise. This is the central objection: CloudFuze's product is meant to be a complete
migration tool, not one that hands the customer a second bill and a second product to
administer just to keep a migrated agent working the way it did before.

**Fit with our Copilot Studio → Gemini Enterprise migration architecture.** Poor fit. Our
migration's value proposition is reproducing what the *source* agent specifically did —
which connector, which exact operation, which exact arguments. Integration Connectors
solves "give an agent a way to call common SaaS systems in general," which is a different
and narrower problem than "reproduce this specific agent's specific behavior."

**Gaps / additional engineering effort identified.** Even after adopting this approach,
CloudFuze would still need to: detect which connector the source agent used, map it to
Google's equivalent (where one exists), build the per-customer connection setup flow, and
handle every connector Google's catalog doesn't cover — which, measured against our own
280+-connector list, is a large fraction. The "no code per connector" goal is not actually
achieved; the same mapping and gap-filling work simply happens against a different vendor's
catalog instead of our own.

**Conclusion on Approach 1: rejected.** It solves a narrower, different problem than the
one we have, permanently binds the customer to a second paid GCP product, and does not
remove the underlying per-connector configuration work. This is the same category of
objection CloudFuze leadership had already raised once before, for Google Vault — adding
a dependency on another Google product the customer must separately provision and
maintain, purely to keep our own tool's output working.

---

### Approach 2 — Dynamic Connector Registry / Spec-Driven Approach (chosen)

This is the approach originally proposed internally, and the one we built out and proved
this session.

**The core idea.** Microsoft already maintains a complete, authoritative specification for
every connector it ships — the exact same specification Copilot Studio itself reads to let
a maker build with that connector. Instead of a developer re-implementing a connector's
behavior by hand, CloudFuze reads that same specification directly, once, and stores it as
**data** — not code — in our own database. When we then detect that a customer's agent
uses that connector, we look up the data, and one shared, already-written mechanism turns
it into a real, callable tool.

**How it works, end to end:**

1. **Capture** — call Microsoft's own Power Platform API (the same one Copilot Studio's
   own maker experience uses) to retrieve a connector's real, live Swagger/OpenAPI-derived
   definition: every operation, its HTTP method and path, its parameters, and its
   authentication shape (OAuth, API key, Basic, etc.).
2. **Registry** — store that as two related, normalized database collections: one row per
   connector (identity, auth shape) and one row per operation (method, path, parameters).
   Not code — data, reusable by every customer who has that connector, forever, until it
   changes.
3. **Detect** — during extraction, CloudFuze already determines which connector(s) a
   specific source agent uses, and — critically — *which specific operations* of that
   connector it calls (an agent using SharePoint might use 3 of SharePoint's 140+
   operations; we only ever need those 3).
4. **Match** — at migration time, look up the agent's specific used operations against the
   registry. This is the dynamic discovery step: nothing about which operations exist, or
   what they need, is hardcoded anywhere.
5. **Execute generically** — a single, shared runtime component turns the matched
   operation data (method + URL + parameters + auth) into a real, working tool call. This
   component does not change per connector; it is written once and reused for every
   connector whose data exists in the registry.
6. **Refresh on a schedule** — a background sweep periodically re-reads each connector's
   live specification, diffs it against what is stored, and updates only what actually
   changed (added/removed/modified operations, changed authentication) — so the registry
   does not go stale the way hand-written code does.
7. **Report honestly** — every connector operation used by a migrated agent resolves to
   one of three honest outcomes, never a silent guess:
   - **Exact reproduction** — the real vendor call is fully known and reproduced exactly.
   - **Working generic fallback** — the connector's real address is known but an exact
     per-operation recipe isn't yet; the agent still gets a genuine, working tool, with
     the model determining the specific call itself.
   - **Not yet supported** — reported plainly in the migration's fidelity report, never
     silently dropped and never claimed as migrated when it wasn't.

**What we specifically researched to build this:**

- **Microsoft Power Platform connector definitions** — the live API
  (`api.powerapps.com/providers/Microsoft.PowerApps/apis/...`) that returns a connector's
  real, current Swagger for a given environment; confirmed this is reachable with an
  app-only token and needs no extra customer consent.
- **Swagger/OpenAPI specification structure** — how a connector's proxy swagger differs
  from a *custom* connector's original swagger (the proxy version fronts every path with
  a Power Platform placeholder; a custom connector's own definition states the real
  vendor host directly).
- **Connector metadata** — publisher, category, display name, and — critically — a
  connector's authentication metadata (`connectionParameters`), including cases with
  multiple distinct credential fields on one connector (e.g. a plain subdomain field
  alongside a real OAuth entry) that must not be conflated.
- **Dynamic tool discovery** — resolving, per real migrated agent, exactly which
  operations of exactly which connectors it uses (proven against real staged agent data,
  not assumed).
- **Runtime execution** — a single generic execution engine (method + URL template +
  parameters + auth) capable of serving any connector's operation from data alone, with
  no per-connector or per-operation code path.
- **Connector registry** — the two-collection normalized schema (`connectors` +
  `connectorOperations`) that stores this data, deduplicated, with no per-customer
  scoping (a connector's shape is the same fact for every customer).
- **Scheduled/cron-based refresh** — a background sweep (currently hourly) that re-checks
  connectors whose stored capture has aged past a threshold.
- **Change detection / diffing** — comparing a fresh capture against the stored copy,
  operation by operation, to identify genuinely added, removed, or changed operations and
  authentication — engineered to avoid false positives from incidental data-format
  differences between a fresh capture and a previously-stored one.
- **Authentication handling** — mapping each connector's real auth shape (OAuth2, API key,
  Basic, Azure AD app-only, etc.) to a small, closed set of credential patterns the
  runtime already knows how to execute.
- **Generic API execution** — proving that one shared code path can serve wildly
  different real connectors (an internal Microsoft Graph service, a third-party SaaS API,
  an Azure data-plane service) purely by varying the data it's given.
- **LLM's role, explicitly bounded** — the LLM is used only to turn a detected,
  mechanically-computed diff into a short, human-readable log sentence for engineers
  reviewing what changed. It is never asked to decide whether something changed (that is
  computed deterministically), and it is never asked to generate the connector
  implementation itself — the runtime execution path is fixed, shared code, not
  LLM-authored.

**How this reduces connector-specific backend code.** For the large majority of
connectors, the *only* thing that ever needs to be supplied per connector is one small
fact — its real base address and which of a handful of known authentication styles it
uses. Everything else (which operations exist, what each needs, how to build the actual
HTTP call for a given agent's specific usage) is handled by data plus the one shared
execution engine. No connector-specific code is written for these cases, ever.

#### What is already proven and built vs. what still needs work

**Already researched, built, and proven (live, not theoretical):**
- 281 real Microsoft connectors captured with their full operation and authentication
  data, sourced directly from Microsoft's own live API.
- The two-collection registry schema, deduplicated, populated, and verified against real
  data (including catching and correcting a real data-quality bug in how multi-credential
  connectors were being collapsed).
- The three-tier resolution (exact / generic fallback / honest refusal), with the exact
  and generic paths both proven against real connectors and real agent data.
- Per-agent operation matching — proven against a real migrated agent's actual tool list,
  confirming only the specific operations that agent uses are ever considered.
- The automatic freshness sweep — proven both for the "nothing changed" case (no false
  positives) and the "something genuinely changed" case (real detection and correction),
  including a false-positive bug found and fixed during verification.
- **150 of the 281 captured connectors currently produce a real, working migrated tool**,
  covering the large majority of Microsoft's own first-party services (Graph-backed
  products, Power Platform admin APIs, most Azure data-plane services) plus a substantial
  set of well-documented third-party SaaS APIs.

**Still to be built:**
- The remaining ~130 connectors split into a few distinct categories, each needing its
  own kind of further work rather than the same fix repeated:
  - Systems that are not REST APIs at all (SQL-family databases, FTP/SFTP, SMTP) — these
    cannot be served by this mechanism as designed and need a different approach entirely
    if support is required.
  - AWS-hosted services (S3, Redshift, SQS) — these authenticate with AWS's own signing
    scheme, which the current runtime does not yet support.
  - A small number of Google-Workspace-equivalent connectors (Google Sheets, Google Tasks)
    that need the same hand-written, cross-vendor treatment already built for Google
    Drive/Calendar/Contacts/Chat, rather than pure data.
  - A long tail of smaller or legacy third-party services where we do not yet have
    confident, verifiable knowledge of the current API — these are being closed
    deliberately, one verified connector at a time, rather than guessed at in bulk.
  - MCP-server-style connector entries, which are already handled by a separate,
    already-built mechanism (resolving an MCP server's declared tools against its
    underlying connector's real operations) and need no registry work at all.
- Prioritization of the remaining connectors should be driven by which ones real customer
  migrations actually encounter, not by working through the full catalog speculatively.

---

## 3. Decision

**We are proceeding with Approach 2 — the Dynamic Connector Registry.**

It directly answers the problem in Section 1: it needs no second product for the customer
to provision or pay for, no ongoing operational dependency beyond CS_GE itself, and it
turns "support a new connector" into a data update rather than an engineering project. It
is also no longer a proposal — 150 of 281 real Microsoft connectors are provably working
through it today, with an honest, quantified account of exactly what remains and why.
