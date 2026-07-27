# CloudFuze Studio Migrate — Migration V1

**Product:** A commercial, multi-tenant tool that migrates AI agents from
**Microsoft Copilot Studio** → **Google Gemini Enterprise** (formerly Google
Agentspace, built on Vertex AI Agent Builder / Discovery Engine).

**Goal:** Fully automated ("push-button") migration — not just an assessment or a
report. Built to be sold to many customers, each with their own Microsoft tenant and
their own Google Gemini Enterprise project.

**Repo:** `c:\Users\ChaitanyaMalle\CS_GE` — Node.js + TypeScript backend (`server/`),
React + Vite frontend (`web/`), MongoDB for persistence.

> This is the V1 reference. It captures **how a customer onboards, how clouds are
> connected, what the tool actually does today, what is proven working, and what is a
> known limitation.** Written to be honest: where something isn't done or isn't
> possible, it says so.

---

## 1. The big picture (in plain English)

Copilot Studio and Gemini Enterprise are fundamentally different:

| | Microsoft Copilot Studio | Google Gemini Enterprise |
|---|---|---|
| How an agent "thinks" | **Deterministic dialog trees** (topics = YAML / Bot Framework, step-by-step) | **Instruction-driven** (you give the LLM a big instruction and it reasons) |
| Building block | Topics, flows, knowledge sources | A low-code agent with one big instruction + tools |

Because there's **no clean 1-to-1 mapping**, we don't blindly copy "topic → something."
Instead the tool follows a **capability-migration** philosophy:

> Extract everything faithfully → understand it → rebuild the agent's *behavior* in
> Gemini's instruction-driven model → verify → report honestly what carried over and
> what didn't.

**Analogy:** we're not photocopying the building's blueprint; we're moving in the
furniture so the new house *behaves* like the old one.

---

## 2. Architecture at a glance

```
   ┌─────────────┐   OAuth    ┌──────────────┐   extract    ┌──────────────┐
   │  Customer   │──────────▶ │  CloudFuze   │────────────▶ │  Copilot     │
   │  admin      │            │  Studio      │              │  Studio      │
   │ (browser)   │            │  Migrate     │   (Dataverse │  (Dataverse) │
   └─────────────┘            │  (this tool) │    Web API)  └──────────────┘
                              └──────┬───────┘
                                     │  normalize → IR (AgentIR) → map
                                     ▼
                              ┌──────────────┐   create/publish/share   ┌──────────────┐
                              │  Deterministic│───────────────────────▶ │  Gemini      │
                              │  mapper +     │   (Discovery Engine      │  Enterprise  │
                              │  emitter      │    v1alpha API, as SA)   │  (customer's │
                              └──────────────┘                          │   project)   │
                                     │  verify + report                 └──────────────┘
                                     ▼
                              ┌──────────────┐
                              │  MongoDB      │  (lossless IR + flat queryable copies)
                              └──────────────┘
```

**Core pipeline:** `extract → IR → map → create → verify → report`
The IR (Intermediate Representation, `AgentIR`) is the heart — a normalized JSON of
each agent that is **target-independent**, so the destination could be swapped later.

---

## 3. Onboarding — how a customer gets set up

A real customer **already owns their own Gemini Enterprise** (their org, their project,
their subscription/seats). We **never** hand them our project. Onboarding connects the
two clouds and grants our tool the access it needs.

### 3.1 Connect Microsoft (source — Copilot Studio)
- The admin signs in with **Microsoft OAuth** (popup + `postMessage` back to the app,
  matching the GEM_CO UX — not a full-page redirect).
- Endpoints: `/auth/microsoft/start` (kicks off, `?popup=1`) → `/callback/microsoft`
  (returns HTML that messages the opener window and closes).
- Uses CloudFuze's existing **multi-tenant MS app registration** (client id
  `68beff40-49fb-4e36-82fe-317bc839a344`), with both delegated and client-credentials
  flows.
- Extraction reads Copilot Studio data from **Dataverse Web API** (see §5.1).

### 3.2 Connect Google (destination — Gemini Enterprise)
- The admin signs in with **Google OAuth** (same popup + `postMessage` pattern).
- Endpoints: `/auth/google/start` (`?popup=1`) → `/callback/google`.
- Purpose of this sign-in: identify the admin and **discover their Gemini project +
  engine**, and prove the tool can reach it.

### 3.3 How the tool gets *write* access to the customer's Gemini project
All Gemini writes run as **CloudFuze's service account (SA)** — the single identity a
customer grants access to. There are **two supported paths**, tried in order:

| Path | When | How writes run |
|---|---|---|
| **1. Direct IAM** *(production, preferred)* | Customer grants the SA the **Discovery Engine Admin** role on their project | as the **SA itself** (direct token) |
| **2. Domain-Wide Delegation (DWD)** *(fallback)* | Customer is on a Google-managed / auto-provisioned project where you can't grant project IAM | SA **impersonates** the signed-in admin |

The orchestrator **auto-detects**: it tries a direct SA token first; if that can't reach
the project, it falls back to impersonation. This is why both an enterprise customer
(direct IAM) and a self-serve project (DWD) both work.

- **Reachability check:** `verifySaReachable(geminiProject, adminEmail)` in
  `routes/auth.ts` runs at connect-time — direct IAM first, DWD fallback, engine
  discovered via `resolveDestination`.

### 3.4 Destination discovery (client-agnostic — no hardcoding)
- `discoverGeminiProject()` scans the admin's accessible GCP projects and **lists the
  engines** in each (it does *not* probe a hardcoded engine name). It prefers a
  chat/assistant engine, else the first project that has any engine.
- `resolveDestination()` lists a project's engines and picks one (chat/assistant
  preferred → search → first).
- `GEMINI_ENGINE` is **never pinned** in production (pinning breaks multi-tenant); the
  engine is discovered per client. `GEMINI_PROJECT_FALLBACK` is a last-resort only.

### 3.5 Persistence across logout
- Sessions and connections are stored in **MongoDB** (`csge` database; the tool runs its
  own mongo container on port `27019`). Cloud connections survive logout — the user
  doesn't have to reconnect every time.

---

## 4. The migration wizard (what the user clicks through)

The React wizard runs these steps in order (reordered so environment selection comes
**before** agent selection):

| # | Step | What happens |
|---|---|---|
| 1 | **Connect** | Connect Microsoft + Google via the popup OAuth flows (§3). |
| 2 | **Choose Pair** | Confirm the source (MS tenant) ↔ destination (Google) pairing for this migration. |
| 3 | **Select & Map Environments** | Lists the customer's Copilot Studio **environments**. User ticks which to include (defaults to those with bots). For each, picks a destination **GCP project** + **engine ("App")** — dropdowns, with a **manual-entry fallback** if project listing is blocked (403). Saves the `environmentMap` locally. |
| 4 | **Select Data** | For the chosen environments, lists the **agents**; user picks which to migrate. |
| 5 | **Dry Run** | A safe preview — resolves the plan and shows what *would* be created, per-agent, **without writing to Gemini**. |
| 6 | **Live Migration** | Runs the real pipeline with live SSE progress + per-agent fidelity cards. |
| 7 | **Report** | Per-agent fidelity report, downloadable as markdown. |

- **Environment prefixing:** optionally the destination display name is prefixed with
  `[EnvName]` so agents from different environments are distinguishable in one project
  (`destination.prefixWithEnv`).
- Frontend↔backend: `web/src/api.ts` exposes `connectViaPopup`, `fetchProjects`,
  `fetchEngines`, `planMigration` (which carries `destination.environmentMap`).

---

## 5. The pipeline in detail

### 5.1 Extraction (Copilot Studio → raw)
Copilot Studio data lives in **Dataverse**. The tool reads:
- `bots` table — the agents.
- `botcomponents` table, filtered by `componenttype`:
  - `9` = **topic** (dialog tree, YAML)
  - `16` = **knowledge source**
  - `15` = **Custom GPT / GptComponentMetadata** — contains the **real agent
    `instructions`** (the single most important field for fidelity).
- `workflows` table (`category eq 5`) — Power Automate flows (inventory only in V1).

**Key fidelity win over the old POC:** the POC ignored the real
`GptComponentMetadata.instructions` and regex-scraped trigger phrases into generic
filler. V1 leads with the **real instructions** — this is why a rich agent migrates with
full behavioral fidelity (proven: a 22,087-character instruction carried over verbatim).

### 5.2 The topic graph parser (lossless)
- `services/topicGraph.ts` → `parseTopicGraph(rawYaml)` turns a topic's YAML into a flat
  `DialogNode[]` graph with edges and node kinds (message / question / condition / loop /
  setVar / action / goto / end / unknown). Unknown kinds are **preserved** (`rawKind`) —
  nothing is silently dropped.
- **Live-validated on 454 real topics:** 100% parsed, 95.8% validate clean, 2,935 nodes.
  Known gap: ~4% of topics fail strict YAML parse (`@odata.id` keys etc.) → raw preserved,
  graph deferred.

### 5.3 The Topics module — 3-layer model + 7-stage pipeline
The hard part of migration is topics (dialog behavior). The agreed production model:

> **Source Topic → canonical Capability (the IR) → destination Connected Agent + Cloud
> Workflow.** Customers see *capabilities / domains*, never Copilot "topics."

- **Unit of migration = the Capability** (not one-sub-agent-per-topic). Capabilities group
  by **domain** into connected agents. Granularity is a client-approved knob:
  `monolithic | domain-grouped | per-capability` (default: domain-grouped).
- **Deterministic core, isolated LLM:** parsing / normalization / grouping / validation
  are **pure code**. The LLM is confined to *one* guardrailed SYNTHESIZE stage (structured
  IR in, JSON-schema out, cites source node ids, verbatim-lock for compliance text).
- **State threading** (`services/stateThreading.ts`) — the keystone. It analyzes the
  variable read/write graph and classifies each variable local / in / out, resolves scope
  (System/Global resolved; a Topic variable read with no writer → flagged UNRESOLVED).
  This captures **behavior**, which plain templating misses (templating preserves *shape*,
  not *behavior*).

**7-stage resumable pipeline:** `PARSE → NORMALIZE → ANALYZE → GROUP → SYNTHESIZE →
VALIDATE → EMIT/DEPLOY`, with **per-item idempotency** keyed on `source_hash` (so a rerun
skips work already done — it's resumable).

### 5.4 Mapping (IR → Gemini agent definition)
- `mapper.ts` builds a Gemini **`lowCodeAgentDefinition`** (an `llmAgentNode` with a model
  like `gemini-2.0/2.5-flash`, tools, starter prompts).
- The agent **instruction** leads with the real Copilot instructions, then appends the
  synthesized "conversation procedures" from the topic capabilities (with a fidelity note
  and a ~200k-char hard cap), plus an "Additional Knowledge References" appendix.
- **Known gap:** thin source agents with a 0-character instruction produce an *invalid*
  Gemini agent (empty-instruction validation error). Fix = synthesize a fallback
  instruction. **Not yet applied.**

### 5.5 Create / publish / share (writing to Gemini)
Proven Discovery Engine **v1alpha** calls (run as the SA):
- **Create:** `POST …/engines/{engine}/assistants/default_assistant/agents` with the
  `lowCodeAgentDefinition`.
- **Publish:** `POST …/agents/{id}:publish` — publishes a revision.
- **Share:** `PATCH …/agents/{id}?updateMask=sharingConfig` with `{scope: ALL_USERS}`.
- Includes **quota backoff** for `RESOURCE_EXHAUSTED`.

### 5.6 Verify
- `verify.ts` checks the agent actually exists in the engine, with a **transient-network
  retry** (`getRetryingTransient` retries `ECONNRESET`/`ETIMEDOUT` on the existence check;
  real HTTP errors are not retried — honest failures surface).

### 5.7 What's stored in MongoDB (the "preserve everything" principle)
Every extracted field is kept **two ways**:
1. **Losslessly** — full IR in `agentIRCache` + the raw source config in a `raw` field.
2. **Flat & queryable** — copies on `stagedAgents` (e.g. `stagedAgents.knowledge[]` with
   id / name / kind / reference / description / strategy / ownership / metadata;
   `topicCapabilities[]`; `topicsSummary`).

This is deliberate: lossless for audit + fidelity, flat for querying and reporting.

### 5.8 Dry-run vs live
- **Dry-run:** runs the whole pipeline up to (but not including) the Gemini write —
  resolves the plan, maps agents, shows the preview. **No API writes.** Ships as the safe
  default.
- **Live:** same pipeline, then actually creates/publishes/shares in Gemini.

---

## 6. What is proven working (live-validated)

- ✅ **MS extraction:** discovered 4 environments; `CloudFuze Migration Test` has 35 bots
  / 451 topics / 5 knowledge sources / 83 flows; extracted real instructions + topics.
- ✅ **Topic graph:** 454 real topics parsed (100%), 95.8% validate clean.
- ✅ **Auth:** SA + DWD token (as `zara@storefuze.com`) reaches the Gemini engine;
  direct-IAM path works on the CloudFuze-owned project.
- ✅ **Write path:** created + published + shared **real agents** live in Gemini
  Enterprise (e.g. "Service Operations Agent", "D365 Sales" agents).
- ✅ **Fidelity:** a **22,087-character** instruction migrated **verbatim** + knowledge
  appendix. This is the core value proof.
- ✅ **Destination picker:** choose project + engine per environment, discovered live (no
  hardcoding).
- ✅ **Topics pipeline** wired end-to-end to dry-run; 60 topic tests pass.

---

## 7. Known gaps & honest limitations

| Area | Status |
|---|---|
| **Empty-instruction thin agents** | Produce an invalid Gemini agent — need a synthesized fallback instruction. *Not yet fixed.* |
| **Unresolved template variables** | Some starter-prompt template vars (e.g. `{Topic.Output.text}`) aren't resolved yet. |
| **Flows / Power Automate** | V1 = **inventory only**. Full flow→Cloud Workflow generation is deferred (connector diversity, Dataverse runtime auth, webhook→Eventarc all unsolved). |
| **Multi-node connected-agent deploy** | Topics can be *emitted* as a connected-agent artifact for dry-run, but deploying multi-node connected agents live is deferred (Gemini API surface shifts — verify live, don't fabricate). |
| **Per-env app-user registration** | 3 of 4 Dataverse envs returned 403 — the app identity must be registered as an application user *per environment* for full multi-tenant extraction. |
| **Destination selection persistence** | The chosen project+engine isn't yet persisted into the session for the orchestrator; today it auto-discovers (fine for single-engine projects). |

---

## 8. The Gemini editions & agent-visibility finding (important for demos & sales)

This is a hard-won, non-obvious result that **shapes what a customer sees after
migration**. Full detail in `docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`.

### The core issue
Migrated agents are created in **`state: PRIVATE`**. Whether they appear in the Gemini
web UI **gallery** depends entirely on the **edition**:

| | **Business edition** | **Standard / Plus editions** |
|---|---|---|
| Gallery type | **Ungated** — lists *all* org agents incl. `PRIVATE` | **Governed** — lists only **`Enabled`** agents |
| Migrated (PRIVATE) agents listed? | ✅ Yes (under "From your organization") | ❌ No |
| Who logs in | Admins **and** users (self-serve) | Admins only |

### Why Standard doesn't list them — and why we can't force it
`state` (`PRIVATE` ↔ `ENABLED`) is **server-controlled by Google**. We tested every API
path to make a migrated low-code agent `Enabled`:

| Attempt | Standard (studio) | Business (the-dispatch) |
|---|---|---|
| `PATCH state=ENABLED` | ❌ 400 immutable | ❌ 400 immutable |
| `:enable` | ❌ 404 | ❌ 404 |
| `:deploy` | ❌ 400 | ❌ 400 |
| `:publish` | ❌ 200 but stays PRIVATE | ❌ 200 but stays PRIVATE |
| **Create with `state:ENABLED`** | ⚠️ **untested (quota-blocked)** | ❌ 200 but coerced to PRIVATE |

`Enabled` appears reserved for Google's own built-in agents (e.g. "Deep Research"). The
**one** path not yet tested on Standard is *create*-with-`ENABLED` (studio's creation
quota is exhausted and deleting agents doesn't free it). On Business it coerced to
PRIVATE; Standard likely does too, but that's **not proven** yet.

### Business is impossible for a managed org
`business.gemini.google` returns **403 "Access to Gemini Business is restricted for your
organization"** for **any managed Workspace account** — even the super-admin (zara),
even with the Admin console's Gemini Enterprise service turned **ON**. Edition is **not**
selectable per app or per project; a managed org (e.g. ibuybutton / storefuze) gets
**Standard/Plus only**. Business requires a **non-managed personal @gmail** account.

### What this means for the product / demos
- **Business-edition customers:** migrated agents appear in the UI immediately. ✅
- **Standard/Plus customers (the common enterprise case):** migration works and agents are
  **usable by direct link** —
  `https://vertexaisearch.cloud.google.com/home/cid/<cid>/r/agent/<agentId>` — but the
  **gallery listing** needs a Google-provided "enable/publish to org gallery" mechanism
  that doesn't currently exist for low-code agents (→ Google Support / roadmap ask).
- **Demo now:** use the **direct agent link** (works today, full fidelity), and set the
  gallery-listing expectation honestly.

---

## 9. Licensing & quota model (the thing that trips everyone up)

Two **independent** layers — confusing them caused a lot of churn:

| Layer | Scoped to | What it is |
|---|---|---|
| **Subscription / seats** | the **organization** (or a standalone project if "No organization") | grants users the *license* to use Gemini Enterprise |
| **Agent-creation quota** | the **individual project** | how many agents you can *create* in that project |

- `RESOURCE_EXHAUSTED / "Agent creation quota exceeded"` = **the project's agent quota is
  used up**, *not* "no subscription."
- **Deleting agents does NOT free the quota** — it's a cumulative / per-period counter,
  not a "slots in use" limit. (Business resets ~daily midnight PT; Standard's reset
  behavior is unknown / may be a hard cap needing a Google quota-increase request.)
- Being **Owner** on a project ≠ having a **seat**. Both are needed.
- **License auto-assignment** can put a user on the wrong subscription (e.g. a Plus free
  trial instead of the paid Standard) → the web app renders the wrong tier. Fix in
  *Manage users* → assign the correct license.

**Parking-garage analogy:** subscription = you paid and the gate opens; quota = the number
of parking spots. All spots full → you still can't park even though you paid.

---

## 10. Production vs dev auth

| Piece | Production | Dev / bypass |
|---|---|---|
| Admin sign-in | **OAuth** (`GOOGLE_AUTH_MODE=oauth`) | hardcoded email (`GOOGLE_IMPERSONATE_EMAIL`) |
| SA access | **direct IAM** (SA has Discovery Engine Admin) | **DWD** impersonation |
| Writes run as | the **SA itself** | SA impersonating a user |
| Engine | **discovered per-client** (`GEMINI_ENGINE` unset) | may be pinned |

Production `.env` is simply:
```env
GOOGLE_AUTH_MODE=oauth
GOOGLE_SA_KEY_FILE=<SA key with IAM on the client/target project>
# GEMINI_ENGINE unset (discovered per-client)
# GEMINI_PROJECT_FALLBACK optional — fallback only
```

The only place CloudFuze needs its own org is where the **service account** lives —
ideally a CloudFuze-owned GCP project under a `cloudfuze.com` org. That SA is the identity
customers grant access to. Everything else is the customer's own Gemini Enterprise.

---

## 11. Design principles (non-negotiable)

1. **Preserve everything, store it two ways** — lossless IR + raw, *and* flat queryable
   copies.
2. **Honesty over overclaiming** — never say something migrated when it didn't; verify
   capabilities against real APIs, don't assume.
3. **Recommendations, not irreversible decisions** — classify + recommend; let the
   customer override; safe defaults.
4. **Separate audiences** — model-facing content (knowledge the agent uses) stays out of
   admin-facing content (audit/reasons live in the report, not the prompt).
5. **Discover, don't hardcode** — derive org facts from both clouds; route by the
   customer's own project/engine; nothing tied to one tenant.

The real success metric is **behavioral fidelity**: *"after migration, my agent answers
the same way."*

---

## 12. V1 scope vs V2 roadmap

**V1 (now):** Agents only. High-fidelity core = real instructions + all topics (as
capabilities) + real starter prompts + post-migration verification + per-agent fidelity
report. Dry-run + live migration + destination picker + popup OAuth for both clouds.

**Deferred to V2:**
- Fix empty-instruction thin agents (synthesize a fallback).
- Resolve remaining template variables in starter prompts.
- Live deploy of multi-node connected agents (topics → connected agent + workflow).
- Cloud Workflow generation for transactional/deterministic tools.
- Full Power Automate flow migration.
- Optional guardrailed LLM synthesis (stage 5) for topic procedures.
- Replay-harness fidelity evidence (prove same-answer behavior automatically).
- Report/UI surfacing of `topicCapabilities`.
- Persist the client's explicit project+engine selection into the orchestrator.
- Standard-edition gallery listing (pending Google's enable-to-gallery mechanism).

---

*Last updated: 2026-07-24. Companion docs: `GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`,
`ONBOARDING_AND_LICENSING.md`, `AGENTIR_V2_SPEC.md`,
`architecture/topics-migration-production.md`.*
