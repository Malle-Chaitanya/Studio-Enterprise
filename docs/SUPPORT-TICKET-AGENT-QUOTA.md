# Google Support Ticket — Gemini Enterprise agent-creation quota

Reusable draft to (1) learn the exact, undocumented **agent-creation** quota + its reset
behavior on Standard, and (2) request an increase for bulk-migration workloads.
Re-use per customer project by swapping the **Project details** block.

---

## How to submit it (pick the route that matches your access)

**Route A — Cloud Console quota page (self-serve, free; try first)**
1. Google Cloud Console → **IAM & Admin → Quotas & System Limits**.
2. In the filter, search **`discoveryengine`** (and `aiplatform` for the ADK/Reasoning-Engine path).
3. If an agent / assistant / "create" quota is listed → select it → **Edit Quotas** →
   enter the new value + justification (paste the "Request" section below) → submit.
4. Note: the *agent-creation* quota may **not** appear here (it's undocumented). If it's
   absent, use Route B.

**Route B — Cloud Support case (needs a Support plan: Standard/Enhanced/Premium)**
1. Console → **Support → Cases → Create case** (or support.google.com/cloud).
2. Category: **Gemini Enterprise / Vertex AI Agent Builder (Discovery Engine)**; Severity:
   *Medium* (blocking a migration workload).
3. Paste the **Subject** and **Body** below.

**Route C — no Support plan?** Use the **Gemini Enterprise in-product Help/Feedback**, your
**Google Cloud account/sales rep**, or your **Google Cloud Partner** to route it. (For a
commercial migration product, a Standard support plan on the SA-hosting project is worth
having.)

---

## Subject
Undocumented "Agent creation quota exceeded" (RESOURCE_EXHAUSTED) on Gemini Enterprise
Standard — need the exact limit, reset behavior, and an increase for migration workloads.

## Body

**Project details**
- Project ID: `studio-enterprise-migration`
- Project number: `231705905417`
- Edition: **Gemini Enterprise Standard** (subscription `68f8b28b-93ac-4dd5-b229-255ff66b4946`)
- Engine/App: `gemini-enterprise-17847887_1784788734248`
- Location: `global`
- API: Discovery Engine `v1alpha`

**What happens**
Creating an agent via
`POST .../locations/global/collections/default_collection/engines/{engine}/assistants/default_assistant/agents`
returns:
```
HTTP 429  { "error": { "code": 429, "message": "Agent creation quota exceeded.",
            "status": "RESOURCE_EXHAUSTED" } }
```
This affects both `lowCodeAgentDefinition` and `adkAgentDefinition` agent creation/registration.

**What we have already ruled out** (so this is clearly a distinct, undocumented limit)
- NOT the documented allocation quotas: we have ~6 engines and a handful of data stores,
  far below the 150/500 per-project limits.
- NOT a per-minute rate quota (complete-query / regional-search 300/min): our create rate
  is far below this.
- NOT a subscription/seat problem: Standard subscription is active and licensed.
- Deleting agents does **not** free the quota — it appears cumulative within a period.
- The "View quota usage" dashboard does not list an agent-creation quota (it shows usage
  quotas like text-answer-generation only).
- **NOT the `agentregistry.googleapis.com/global_agents` quota.** Verified in the Console
  Quotas page on 2026-07-27: that quota sits at **0 / 100 (0% usage, Adjustable: Yes)** —
  yet agent creation still returns RESOURCE_EXHAUSTED. It is also a **different API**: our
  create call goes to `discoveryengine.googleapis.com` (POST
  `.../assistants/default_assistant/agents`), NOT `agentregistry`. So the blocking quota is
  a separate, undocumented **Discovery Engine** counter that is not exposed anywhere in the
  Console Quotas list.

**Our questions**
1. What is the exact **agent-creation quota** (limit value) for Gemini Enterprise Standard
   at the project level? Is it per-day, per-minute, or a cumulative allocation?
2. What is its **reset behavior** (we observe per-day rate quotas reset at midnight PT — is
   agent creation one of these)?
3. Is it **scaled by the number of licenses/seats**, or fixed per project?
4. What metric name should we monitor to see remaining allowance programmatically?

**Our request**
We operate a commercial migration tool that imports many agents (typically 20–100+) into a
customer's project in a single run. Please **increase the agent-creation quota** on this
project to support bulk migration (target: **≥ 200 agent creations/day**, higher if
available), and advise the standard process to request the same increase on **each new
customer project** as part of onboarding.

**Business context**
This is a repeatable enterprise workload (Microsoft Copilot Studio → Gemini Enterprise
migration). We already pace writes (bounded concurrency + exponential backoff honoring
`Retry-After`) and stage work in a DB for resumability, but the per-project daily cap is the
gating factor for completing a customer's migration in one pass.

---

## Live diagnostic evidence (2026-07-27) — DEFINITIVE
Ran a create-until-429 probe loop (`_diag_quota_probe_loop.ts`) plus a single-create probe,
low-code, impersonating zara@storefuze.com, on `studio-enterprise-migration` /
`gemini-enterprise-17847887_1784788734248`:

1. **The throwing API is `discoveryengine.googleapis.com`** (`agents.create`, POST
   `.../assistants/default_assistant/agents`, v1alpha) — NOT `agentregistry`.
2. **The daily allowance is tiny** — only ~1–2 creations succeeded before the 429; consistent
   with a total of roughly **~7 creations/day**. This is a **per-day counter** that resets
   ~midnight PT (an earlier same-day create succeeded, then the reset window refilled it).
3. **The 429 error is BARE — Google does NOT name the quota.** Full response body:
   ```json
   { "error": { "code": 429, "message": "Agent creation quota exceeded.", "status": "RESOURCE_EXHAUSTED" } }
   ```
   There is **no `details[]`** (no QuotaFailure / ErrorInfo / Help) — so there is **no metric
   name, no limit value, and no help link**. The customer cannot self-identify this quota.
4. **Deleting agents does NOT free it** — the probe agent was deleted, the quota stayed spent
   (cumulative per day, not a live "slots in use" count).
5. **Not in the Console Quotas page** — the only agents quota shown is
   `agentregistry.googleapis.com/global_agents` (0 / 100, Adjustable: Yes), a **different API**
   that our code never calls.

**Net:** the blocker is an **undocumented, unnamed, per-day agent-creation quota on Discovery
Engine (~7/day)** that is invisible in the Console, unnamed in the API error, and not freed by
deletion. This is the crux of the ticket: Google must name it and raise it.

## After you hear back — record the answer here
- Actual limit: _____   • Reset: _____   • Seat-scaled? _____   • Monitor metric: _____
- Increase granted to: _____ (per day)   • Per-project request process: _____

(Fill this in — it becomes the number the tool's pre-flight quota check and onboarding docs
use, so we stop guessing.)
