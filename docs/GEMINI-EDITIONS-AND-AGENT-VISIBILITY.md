# Gemini Enterprise — Editions, Agent Visibility & Migration Findings

Hard-won findings from getting migrated Copilot Studio agents to appear in the
Gemini Enterprise UI. Read this before onboarding any customer — it explains why
agents show in some accounts and not others, and what to check.

---

## 1. The two environments we worked with

| | **studio-enterprise-migration** (CloudFuze's own) | **the-dispatch-0vzc3** (zara's) |
|---|---|---|
| Project number | `231705905417` | `860501065102` |
| Organization | `ibuybutton.com` | "No organization" (Google auto-provisioned) |
| Edition | **Gemini Enterprise Standard** (paid, $35/mo/seat) | **Gemini Enterprise Business** (self-serve) |
| Subscription id | `68f8b28b-93ac-4dd5-b229-255ff66b4946` ("Studio-Enterprise") | — |
| Engine id | `gemini-enterprise-17847887_1784788734248` | `agentspace-engine` ("Zara Z's Team") |
| Web app cid | `4632a92e-b1c6-45a6-be35-8ad5b5da9c0a` | `96c55072-784e-4f9d-b718-d4cd8b416666` |
| SA access | **Direct IAM** (SA is Owner) | **DWD** (SA impersonates zara — managed project, can't grant IAM) |
| Agent-creation quota | Standard cap (filled after ~7 test agents) | Business **daily** cap (resets ~midnight PT) |
| Migrated agents show in web UI gallery? | ❌ **No** (see §4) | ✅ **Yes** — under "From your organization" |

SA email (CloudFuze's identity, granted access per client):
`studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com`

---

## 2. Editions — the core distinction (this explains everything)

| | **Business edition** | **Standard / Plus editions** |
|---|---|---|
| Who it's for | small teams / SMB | mid-to-large enterprises |
| Login model | **admins AND users** log in directly (self-serve) | **admins only**; other users "ask your admin how to log in" |
| Admin management | in the web app | in the **Cloud Console** ("Admin log in" → console) |
| Agents gallery | **ungated** — lists ALL org agents, including **Private/draft** ones | **governed** — lists only **Enabled/published** agents |
| Migrated (Private) agents in gallery | ✅ shown (under "From your organization") | ❌ hidden; **no self-serve "Enable"** |

**Which do customers use?** Companies with Copilot Studio agents to migrate are
mid-to-large **enterprises** (M365 E3/E5, Power Platform, Dynamics 365) → they buy
**Standard/Plus**. So **the Standard gallery limitation is the COMMON case for real
customers, not an edge case.** Business is mostly SMB self-serve.

---

## 3. The agent-visibility saga (causes ruled out, in order)

Migrated agents weren't appearing in studio's (Standard) web UI. We ruled out,
one by one:
1. **Identity** — set up Google Identity on the app. ✅ (still didn't show)
2. **IAM role** — granted zara `Gemini Enterprise User` (`roles/discoveryengine.agentspaceUser`). ✅ (still didn't show)
3. **Agent validity** — thin agents (0-char instruction) produced an invalid agent (empty-instruction validation error); rich agents (e.g. Service Operations, 22k chars) are valid. Fidelity proven — full instruction + knowledge appendix migrated verbatim. ✅
4. **Propagation** — waited 24h+. ✅ (still didn't show)
5. **Ownership** — agents created by the SA (direct IAM) are SA-owned → not in a user's "Your agents"; created via DWD-as-zara → zara-owned. ✅ (still didn't show on Standard even as zara)

### Root cause 1 — LICENSE MISMATCH (fixed)
studio had **two** subscriptions: the paid **Standard** (1 license, 0 assigned) and
a free **Plus trial** (`free_trial_gemini`, 50 licenses). **Auto-assignment was set
to the Plus trial**, so zara + the SA got **Plus** licenses → the web app rendered
**"Plus"** and put zara in the wrong (trial) experience. **Fix: reassign zara to the
Standard license** (Manage users → assign Standard). After this, the web app
correctly rendered **"Standard"** and the agent was reachable.

### Root cause 2 — EDITION GALLERY BEHAVIOR (not fixable by config)
Even after the license fix, Standard's gallery still didn't **list** the agents.
Reason: **migrated agents are in `state: PRIVATE`**; Standard's **governed** gallery
lists only **`Enabled`** agents (like Google's "Deep Research" = Enabled). There is
**no self-serve way** to flip Private → Enabled: the per-agent **⋮ menu has only
Preview / Delete**; the "Agent Settings" gear only controls **Marketplace** (third-
party) visibility, not employee-made agents. Business's **ungated** gallery lists
Private agents; Standard's does not.

---

## 4. Where migrated agents appear (by edition)

- **Business (the-dispatch):** migrated agents appear under **"From your organization"**
  (they're SA/impersonation-created + shared ALL_USERS → classified as org agents,
  not the viewer's personal "Your agents"). **Access via the Business "Log in" flow**
  (cloud.google.com/gemini-enterprise → Choose edition → Business → Log in) — the
  **direct cid URL 403s** ("Access to Gemini Business is restricted for your
  organization" — an org policy).
- **Standard (studio):** agents **exist in the engine** (console Agents view shows
  them) and are **usable by direct agent URL**
  (`vertexaisearch…/cid/<cid>/r/agent/<agentId>` → New chat), but are **NOT listed**
  in the web app gallery, and **cannot be enabled** via the console.

---

## 5. Migration tool status — WORKS

- Extracts Copilot Studio agents → creates Gemini agents (`lowCodeAgentDefinition`)
  → publishes revision → shares `ALL_USERS` → verifies. `deployed=true shared=true
  verified=true`.
- **Fidelity proven:** 22,087-char instruction migrated verbatim + "Additional
  Knowledge References" appendix.
- Destination **picker** (Select & Map): choose project + engine per environment,
  discovered live (no hardcoding). Wizard reordered: Select & Map → Select Data.
- Auth: **direct SA IAM first, DWD fallback** — both onboarding paths supported.
- Two gaps identified:
  - **Empty-instruction agents** (thin source) produce invalid Gemini agents — should
    synthesize a fallback instruction.
  - **Publish state:** the `:publish` call publishes a revision but leaves `state:
    PRIVATE` — it does NOT promote the agent to `Enabled`/org-gallery on Standard.

### `state: ENABLED` appears server-controlled — no working API path found (edition-tagged)
Attempts to make a low-code agent `Enabled` (gallery-listable), with the edition each
was actually tested on:
| Attempt | Standard (studio 231705905417) | Business (the-dispatch 860501065102) |
|---|---|---|
| `PATCH state=ENABLED` | ❌ 400 immutable (tested 2026-07-24) | ❌ 400 immutable |
| `PATCH state=PUBLIC` | ❌ 400 invalid value (tested) | — |
| `:enable` | ❌ 404 (tested) | ❌ 404 |
| `:deploy` | ❌ 400 (tested) | ❌ 400 |
| `:publish` | ❌ 200 but stays PRIVATE (tested) | ❌ 200 but stays PRIVATE |
| **Create with `state:ENABLED`** | ⚠️ **UNTESTED — blocked by 429 quota** | ❌ 200 but coerced to PRIVATE (tested) |

**Honest status:** every path to promote an *existing* agent to `Enabled` fails on
BOTH editions. The ONE path not yet tested on Standard is *create*-with-`ENABLED`
(studio quota exhausted; deleting agents does NOT free it). On Business that create
path coerced to PRIVATE. Standard matches Business on every other path, so it is
LIKELY (not proven) to coerce too. **To close this: retry create-with-`ENABLED` on
studio once its creation quota frees** (`_diag_create_enabled_keep.ts 231705905417
<engine> <cid>`). If it also coerces → confirmed no API path; if it sticks → that's
the Standard fix, wire `state:ENABLED` into agent creation.

Also confirmed: **deleting agents does NOT free the agent-creation quota** on either
edition — the quota is a cumulative/per-period counter, not a "slots in use" limit.
(Business resets ~daily midnight PT; Standard's cap did not free on delete.)

---

## 6. The production gap + next step

**For Standard/Plus customers (the common case), migrated agents won't auto-list in
the web UI gallery, and there's no self-serve Enable.** To close this, we need the
Google **"publish/enable agent to the org gallery"** mechanism for Standard/Plus
(low-code agents). The console has no such action; the docs cover *registering
ADK/pro-code agents*, not promoting low-code ones. **→ Google Cloud Support / partner
question** to get the exact API or confirm it's roadmap.

Support ask (draft):
> "Standard-edition app `gemini-enterprise-17847887…` (project studio-enterprise-
> migration). Low-code (agentspace) agents created via the API exist in the engine and
> open via direct link, but stay in `state: PRIVATE`, are NOT listed in the web app
> Agents gallery ('From your organization'/'Your agents'), and the console offers no
> Enable action (only Preview/Delete). How do we programmatically promote/enable a
> low-code agent to the org gallery on Standard/Plus?"

---

## 7. Practical guidance

- **Demo now:** use **the-dispatch (Business)** via the Business "Log in" flow →
  migrated agents show under "From your organization." Watch the **daily** quota
  (migrate a few agents; wait for reset if exhausted).
- **Business-edition customers:** migrated agents appear in the UI immediately. ✅
- **Standard/Plus customers:** migration works; agents are usable by link; **UI-gallery
  listing needs the enable-to-org step** (Support/roadmap). Set this expectation.
- **`.env` targeting:** `GEMINI_PROJECT_FALLBACK=860501065102` + bypass + impersonate
  zara → the-dispatch (agents as zara). For studio: `studio-enterprise-migration`.

---

## 8. Addendum (2026-08-03) — console rebrand, and "does enabling the Studio API help?"

Google Cloud Next 2026 rebranded **Vertex AI + Agentspace → "Gemini Enterprise Agent
Platform."** The console path moved to `console.cloud.google.com/agent-platform/studio/...`
(e.g. `.../settings/api-keys?project=studio-enterprise-migration`), but it is the **same
underlying Agent surface** — no new product, no new capability.

That settings page's "API Keys are Disallowed — use ADC instead" notice is an **org
auth-mechanism policy**, not a capability gate. Enabling the API shown there does **not**
unlock a way to build a low-code agent "in Studio" and deploy it that bypasses the §5
gap above:

- Studio/Agent Designer-built agents live on the identical Discovery Engine `v1alpha`
  `Agent` resource (`.../assistants/default_assistant/agents`) that this tool already
  creates via `services/gemini.ts`. Confirmed independently via a Google Developer
  forum thread on calling the Agent Designer API
  ([discuss.google.dev thread](https://discuss.google.dev/t/making-api-calls-to-no-code-agents-agent-designer-in-gemini-enterprise-agentspace/290026))
  and Google's own [Agent Studio design docs](https://docs.cloud.google.com/gemini-enterprise-agent-platform/agent-studio/design-agents),
  which describe Studio as a console-only workflow with no separate flow-authoring or
  publish API.
- Per [docs/LIMITATIONS-EDITING-AGENTS.md](LIMITATIONS-EDITING-AGENTS.md) §1, API-created
  agents aren't even Designer-editable (only Preview/Delete) — reinforcing that "build
  via API" and "build in Studio" are the same resource, not two paths with different
  capabilities.
- The separate [Agent Platform API REST reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest)
  is the broad, merged Vertex AI surface (models, RAG, Reasoning Engine/Agent Runtime)
  — that's the ADK/Agent-Runtime deployment surface `adkDeployer.ts` already targets,
  not a richer low-code authoring API.

**Conclusion: no code or approach change.** Continue `AgentIR → Discovery Engine v1alpha`
creation; the PRIVATE→ENABLED gap in §5/§6 is unaffected by which API is "enabled" on
this settings screen — it needs the Google Support / roadmap answer already tracked in §6.

**Unverified / cheap to close:** whether the rebranded console calls a newly-versioned
endpoint rather than plain `discoveryengine.googleapis.com`. Check with `gcloud services
list --enabled` on `studio-enterprise-migration` before/after enabling the API on that
screen.
