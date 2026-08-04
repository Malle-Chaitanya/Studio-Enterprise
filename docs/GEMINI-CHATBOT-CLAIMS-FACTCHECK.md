# Fact-Check: "Make migrated agents appear in the Standard gallery"

Every popular fix for *"my API-migrated agent doesn't show in the Gemini Enterprise
Standard web UI gallery"* — including several suggested by Google's own Gemini chatbot —
was tested empirically against a **live** agent in our engine. **All of them fail.**
This file records the exact calls and results so nobody re-litigates it.

- **Project:** `studio-enterprise-migration` (`231705905417`), Gemini Enterprise **Standard**
- **Engine:** `gemini-enterprise-17847887_1784788734248` · location `global`
- **Test agent:** `10175339144811279956` ("Sales Opportunity Agent"), API-created, `lowCodeAgentDefinition`
- **Dates:** 2026-07-24 → 2026-07-26

---

## TL;DR

A migrated **low-code** agent (`lowCodeAgentDefinition`) is created in **`state:
PRIVATE`** and **can never be made `ENABLED`** — no API, button, IAM role, sharing, or
setIamPolicy changes it. Standard's governed gallery lists only `ENABLED` agents, so
low-code agents are usable **only by direct link**, never gallery-listed.

**BUT (proven 2026-07-26): gallery visibility IS achievable — with a different agent
TYPE.** An **`adkAgentDefinition`** agent (built as ADK → deployed as a Vertex AI
**Reasoning Engine / Agent Runtime** → registered into the engine) is created **`state:
ENABLED`** and **appears in the gallery**. The difference is the agent *type*, not a
setting. So the real choice is: low-code (simple, PRIVATE, direct-link) vs ADK/Agent
Runtime (heavy: compute per agent, but ENABLED + gallery-visible). See §"THE FIX" below.

---

## The real agent object (ground truth)

A live `GET` on the agent returns exactly these top-level fields:

```
name, displayName, description, icon, createTime, updateTime,
state, starterPrompts, lowCodeAgentDefinition, sharingConfig,
activeRevision, agentIdentityInfo
```

Notes that decide everything below:
- **No `labels` / `metadata` / `annotations` field** → you cannot attach structured
  metadata (e.g. source environment) to an agent. Only `displayName`, `description`,
  `starterPrompts`, and the `instruction` are author-settable.
- **`state`** is present but **read-only / system-managed** (see tests).
- **`sharingConfig: { scope: "ALL_USERS" }`** — sharing (who can access) is a DIFFERENT
  field from `state` (whether the gallery lists it). Sharing ≠ enabling.

---

## Claims tested — all FALSE

| # | Claim (source) | Test | Result |
|---|---|---|---|
| 1 | `PATCH state=ENABLED` promotes the agent | PATCH `?updateMask=state` | ❌ **400 "immutable path 'state'"** |
| 2 | `PATCH state=PUBLIC` | PATCH | ❌ 400 invalid enum value |
| 3 | `:enable` method exists | POST `…:enable` | ❌ **404** (no such method) |
| 4 | `:deploy` method | POST `…:deploy` | ❌ 400 invalid argument |
| 5 | `:publish` promotes to gallery | POST `…:publish` | ❌ 200 but **state stays PRIVATE** |
| 6 | Create with `state:ENABLED` sticks | POST create body incl. `state:ENABLED` | ❌ 200 but **coerced back to PRIVATE** (Business); **untested on Standard — quota-blocked**, but every other path matches, so almost certainly the same |
| 7 | **`setIamPolicy` flips PRIVATE→ENABLED** (Gemini chatbot) | POST `…:setIamPolicy` + `:getIamPolicy` | ❌ **`getIamPolicy` → 404 (route doesn't exist); `setIamPolicy` → 400 "Policy etag is required"; state unchanged** |
| 8 | **Enabling platform APIs** (Agent Registry, IAM, App Hub, Model Armor, …) unlocks publishing | Enabled the APIs, re-`GET` the agent | ❌ **No change** — same fields, `state` still `PRIVATE` |
| 9 | **"Manage in Dialogflow CX" / Publish Agent** button | Inspected the agent + console | ❌ Agent is `lowCodeAgentDefinition` in **Discovery Engine**, NOT a Dialogflow CX agent — no such path; three-dot menu shows only **Preview / Delete** |
| 10 | Direct URL is `gemini.google.com/app/agent/[ID]` | Host analysis | ❌ Wrong host — that's **consumer** Gemini. Enterprise agents live at `vertexaisearch.cloud.google.com` |
| 11 | **PATCH `sharingConfig.scope="ORGANIZATION"`** forces UI visibility (Gemini chatbot) | PATCH `?updateMask=sharingConfig`, 4 scope values | ❌ **`ORGANIZATION`/`SHARED`/`PUBLIC` → 400 invalid enum** (not in `Agent.SharingConfig.Scope`); only `ALL_USERS` valid → 200 but **state stays PRIVATE**. And the agent was **already `ALL_USERS`** (our `shareAgent()` sets it) — so sharing is not the gate |
| 12 | **A `visibility` / `gallery_visibility` field set to `ORGANIZATION`** makes the agent gallery-visible (Gemini chatbot) | Live `GET` field list + official v1alpha REST/RPC schema | ❌ **No such field exists on any API version.** Real Agent fields are exactly: `name, displayName, description, icon, createTime, updateTime, state, starterPrompts, lowCodeAgentDefinition, sharingConfig, activeRevision, agentIdentityInfo`. Chatbot conflated it with `sharingConfig.scope` (claim #11), which only accepts `ALL_USERS` and does not flip `state` |
| 13 | **A Workspace Admin "Gemini Enterprise › Apps › Gallery Management" console can "Approve" a private agent into the org gallery** (Gemini chatbot) | Official "Share an agent" + "Agent Gallery" docs | ❌ **No console named "Gallery Management."** The only real admin surface is **Apps › [app] › Agents → "Review share request"**, gated by the feature control *"Enable agent sharing without admin approval."* It approves **who may access** an owner-shared agent — it does **not** change `state` or promote a PRIVATE low-code agent into the gallery. No admin-side path to gallery visibility exists; the only proven path is changing the agent **type** to ADK (`state: ENABLED`) |

### Key raw outputs

**setIamPolicy (claim #7):**
```
state BEFORE   = PRIVATE
:getIamPolicy  → 404   (HTML "Error 404" page = route not registered on the agent resource)
:setIamPolicy  → 400   { "error": { "message": "Policy etag is required." } }
state AFTER    = PRIVATE
```
Why it can't work, three independent reasons:
1. `getIamPolicy` returns an **HTML 404** → the method doesn't exist on agents (no
   per-agent IAM policy to get).
2. `setIamPolicy` **requires an `etag`** obtainable only from `getIamPolicy` → chicken-
   and-egg dead end.
3. Even if it ran, **IAM policy controls WHO can access, not the `state` field.** IAM ≠
   lifecycle. Category error.

**API enablement (claim #8):** after enabling Agent Registry / IAM / App Hub / Model
Armor / Network Security / Observability / etc., a fresh `GET` returned the **same
fields** and **`state: PRIVATE`**. Platform APIs don't touch the low-code data model.
(For our tool, the only API that matters is **Agent Platform / Discovery Engine**, which
was already enabled. "Agent Registry API" is for **pro-code/ADK** agents, not low-code.)

---

## What actually works

- **Direct agent link** (enterprise host, licensed user):
  ```
  https://vertexaisearch.cloud.google.com/home/cid/<CID>/r/agent/<AGENT_ID>
  ```
  e.g. `…/cid/4632a92e-b1c6-45a6-be35-8ad5b5da9c0a/r/agent/10175339144811279956`
  Opens for a user who holds a **Standard license seat** (a project Owner IAM role alone
  is NOT enough — the seat is required to enter the web app).
- **Business edition** *would* list PRIVATE agents (ungated gallery) — but Business is
  **blocked (403) for any managed Workspace org**, cannot attach to your GCP project, and
  has **no clean upgrade path** to Standard. Not viable for enterprise/multi-tenant. See
  `GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`.

---

## THE FIX (proven 2026-07-26): ADK / Agent Runtime type = ENABLED + gallery-visible

Two agent TYPES exist in a Gemini Enterprise engine. Only one can be `ENABLED`:

| | Low-code (migrated) | **ADK / Agent Engine** |
|---|---|---|
| Definition field | `lowCodeAgentDefinition` | **`adkAgentDefinition`** (`provisionedReasoningEngine` → a Vertex AI Reasoning Engine) |
| Console "Agent type" | "Employee-made" | "Agent Engine" |
| Created state | **PRIVATE (locked forever)** | **ENABLED** (automatically) |
| Gallery-listed | ❌ never | ✅ yes |
| Lifecycle actions | Preview / Delete | Preview / Disable / Suspend / Delete |

Raw proof — same engine, two agents:
```
Migrated:  state=PRIVATE  "lowCodeAgentDefinition": {...}
ADK:       state=ENABLED  "adkAgentDefinition": { "provisionedReasoningEngine":
             { "reasoningEngine": ".../locations/us-west1/reasoningEngines/7415009660698099712" } }
```

**How the ADK path is produced (all API-automatable):**
1. Build/generate an **ADK agent** (Python `LlmAgent` — the migrated instruction goes in
   `instruction=`; fidelity preserved). Use a **stable model** (`gemini-2.5-flash`) — the
   preview `gemini-3.5-flash` + global-location hack fails to deploy ("Reasoning Engine
   failed to start").
2. **Deploy** it → creates a Vertex AI **Reasoning Engine** (`reasoningEngines.create`,
   regional e.g. us-west1). This is real always-on compute.
3. **Register** into the engine: `agents.create` with `adkAgentDefinition.
   provisionedReasoningEngine = <reasoningEngine resource>`. Result: `state=ENABLED`.

**Cost/complexity reality:** one Reasoning Engine **per agent** (35 agents = 35 deployed
runtimes per customer) + deploy-failure handling + region management. Heavy but works.
This is the ONLY proven path to gallery-visible migrated agents on Standard.

## Build the tool around these truths

1. **Do not** add code to flip `state`, call `setIamPolicy`, enable extra APIs, or open
   Dialogflow CX to "publish." All are dead ends (proven above).
2. **Capture `agentId`** from the create response and **output the real direct link**
   (`vertexaisearch.cloud.google.com/home/cid/<CID>/r/agent/<AGENT_ID>`). The `<CID>` is
   the engine's web-app id (per engine; not API-derivable — record it at setup).
3. **Set customer expectation honestly:** migration is full-fidelity; agents open by
   direct link; **gallery auto-listing on Standard is a pending Google-side capability**
   for low-code agents (Support/roadmap).
4. **Seats matter:** assign each end user a **Standard license seat** (not just IAM) or
   they can't enter the web app at all.

---

## Open item (not overclaimed)

The single path not yet run on **Standard specifically** is *create-with-`state:ENABLED`*
(studio's creation quota is exhausted; deleting agents does NOT free it). On **Business**
it coerced to PRIVATE. Given Standard matches Business on every other path, it is
**likely** to coerce too — **but that's inference, not proof.** To close it: retry
`_diag_create_enabled_keep.ts 231705905417 <engine> <cid>` once studio's quota frees.

---

*Diagnostics used: `_diag_setiam.ts`, `_diag_agent_raw.ts`, `_diag_publish_agent.ts`,
`_diag_create_enabled_keep.ts`. Companion: `GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md`,
`MIGRATION-V1.md`.*
