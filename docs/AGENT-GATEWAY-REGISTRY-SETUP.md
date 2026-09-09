# Agent Gateway & Registry Setup

How we enabled governed MCP connectivity on the Gemini Enterprise destination side.
Verified end to end on the `agentmigrations` test project (2026-08-28).

## What this unlocks

Gemini Enterprise ships a small set of Google-managed MCP servers by default, but they
only become attachable to an app once **Agent Gateway** bridges the app to your **Agent
Registry**. This is the one-time infrastructure setup that turns on **Path B** —
governed, reusable MCP connections — alongside the zero-setup Custom MCP Server path
(Path A).

## Before you start

- Billing enabled on the target GCP project — Compute Engine and Cloud DNS refuse to
  enable without it.
- An account with rights to grant IAM roles on the project (Owner, or
  `resourcemanager.projectIamAdmin`).
- Your Gemini Enterprise app's location noted — it decides the gateway's region.

## Setup, in order

### 1. Enable the required APIs

21 services span networking, observability, and the agent platform itself — split into
two calls, `gcloud` caps a single batch at 20.

```bash
gcloud services enable \
  compute.googleapis.com networksecurity.googleapis.com \
  networkservices.googleapis.com dns.googleapis.com \
  iam.googleapis.com agentregistry.googleapis.com \
  aiplatform.googleapis.com discoveryengine.googleapis.com \
  storage.googleapis.com modelarmor.googleapis.com \
  observability.googleapis.com telemetry.googleapis.com \
  monitoring.googleapis.com cloudtrace.googleapis.com \
  logging.googleapis.com apphub.googleapis.com \
  apptopology.googleapis.com cloudapiregistry.googleapis.com \
  notebooks.googleapis.com texttospeech.googleapis.com \
  --project=PROJECT_ID

gcloud services enable dataform.googleapis.com --project=PROJECT_ID
```

### 2. Grant the five IAM roles

Google doesn't publish one bundled role for this — each candidate was confirmed by
inspecting its actual permission list before granting, not assumed from the name:

```bash
ME=$(gcloud config get-value account)

gcloud projects add-iam-policy-binding PROJECT_ID --member="user:$ME" --role="roles/networkservices.admin"
gcloud projects add-iam-policy-binding PROJECT_ID --member="user:$ME" --role="roles/networksecurity.admin"
gcloud projects add-iam-policy-binding PROJECT_ID --member="user:$ME" --role="roles/modelarmor.admin"
gcloud projects add-iam-policy-binding PROJECT_ID --member="user:$ME" --role="roles/compute.networkViewer"
gcloud projects add-iam-policy-binding PROJECT_ID --member="user:$ME" --role="roles/iap.egressor"
```

### 3. Create the gateway

Region is fixed by app location: `global`/`us` → `us-central1`, `eu` → `europe-west1`.
The registry reference needs the full `//agentregistry.googleapis.com/…` form, not a
bare resource path.

```bash
cat > agent-gateway-egress.yaml << 'EOF'
name: studio-enterprise-agent-gateway
protocols:
  - MCP
googleManaged:
  governedAccessPath: AGENT_TO_ANYWHERE
registries:
  - //agentregistry.googleapis.com/projects/PROJECT_ID/locations/global
EOF

gcloud network-services agent-gateways import studio-enterprise-agent-gateway \
  --source="agent-gateway-egress.yaml" --location=us-central1
```

### 4. Bind the gateway to the app

Console: app → **Security** tab → **Agent Gateway configuration** → paste the
gateway's full resource name → **Save**.

```
projects/PROJECT_ID/locations/us-central1/agentGateways/studio-enterprise-agent-gateway
```

### 5. Confirm the registry is reachable

**Connected data stores → + New data store → MCP servers → Show all.** Before the
bind, this list is empty; after, it lists every registry entry. In our test, 15
Google-managed servers appeared immediately — `discoveryengine`, `bigquery`,
`compute`, `storage`, and others already auto-registered when their APIs were enabled.

### 6. Register a Workspace MCP server

Gmail, Chat, Drive, Calendar, and People aren't auto-registered like the Cloud APIs —
they live behind Agent Registry's **Discover Google Cloud MCP servers** catalog, in
Developer Preview, and need one click each to enable and register. This is the piece
that matters most for a Microsoft → Google tenant migration: it's the confirmed,
working destination side of a Teams → Chat or Outlook → Gmail tool mapping.

## Gotchas hit along the way

| Symptom | Cause & fix |
|---|---|
| `INVALID_ARGUMENT: max batch size (20)` | `gcloud services enable` caps a single call at 20 services — split 21 into two calls. |
| `iamconnectors.googleapis.com` — permission denied | Blocked by an org-level policy above project Owner. Not on the required list for Gateway/MCP — safe to ignore. |
| Registry path doesn't match pattern | Needs the fully-qualified form `//agentregistry.googleapis.com/projects/{project}/locations/{location}`, not a bare `projects/…` path. |
| Workspace MCP servers missing from the picker | They're opt-in via Agent Registry's Discover catalog, not pre-registered — register once, then they appear like any other entry. |

## Cost & risk notes

Billing is usage-based — Agent Gateway (Agent-to-Anywhere) bills per API call routed
through it. Deploy new gateways in **Audit-only** mode first: traffic passes through
unblocked and only logs, so existing agents are never at risk while testing. Only
switch to Enforce once the audit log confirms expected behavior.

## Open follow-up

CORRECTED 2026-09-02 (researched, not re-tested live): registering a third-party MCP
server (HubSpot, GitHub, etc.) is NOT manual-field-entry-only as this doc originally
said — there's a real API path:

- **Registration**: `gcloud agent-registry services create` writes a `Service` resource
  from a `toolspec.json` (max 10KB, a `tools` array with name/description/annotations).
  Needs `roles/agentregistry.editor`.
- **Auth brokering**: a separate but linked product, Agent Identity, can hold the
  third-party credential — `gcloud alpha agent-identity connectors create ... --api-key=`
  (or OAuth), then an IAM binding grants the specific calling agent
  (`principal://...reasoningEngines/ENGINE_ID`) access to that one connector. ADK code
  references it via `GcpAuthProviderScheme` on `McpToolset`, and `get_mcp_toolset()`
  resolves the binding automatically. Where Google stores the raw secret underneath is
  NOT documented — treat as unconfirmed, don't assume Secret Manager.
- **Still console-only**: attaching the registered server into the destination Gemini
  Enterprise APP (Connected data stores -> MCP servers -> Add tool -> paste OAuth
  Client ID/Secret/Scopes) has no documented gcloud/REST equivalent. This is the one
  step blocking a fully unattended, per-customer automation today.
- **Agent Registry is Pre-GA** ("available as-is, might have limited support") per
  Google's own overview page — factor that into any commitment made to a customer.

Everything above is from documentation research, not a live re-test on `agentmigrations`
— confirm against a real HubSpot registration attempt before relying on it. See the MCP
migration design discussion for how this ties into `AgentToolIR` / `connectorToolBuilder.ts`.
