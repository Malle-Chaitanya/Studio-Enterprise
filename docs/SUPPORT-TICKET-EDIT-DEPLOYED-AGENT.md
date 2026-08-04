# Google Support Ticket — No way to edit migrated / ADK-deployed agents in Google's UI

Reusable draft to confirm with Google whether a **migrated / programmatically-created agent**
(especially an **ADK / Agent Runtime** deployment) can be opened and edited in Google's own
**Agent Designer / Agent Studio**, or whether that is a platform limitation with no API path.
Re-use per customer project by swapping the **Project details** block.

Companion analysis: `LIMITATIONS-EDITING-AGENTS.md` (full type-by-type breakdown + evidence).

---

## How to submit it

**Route B — Cloud Support case (needs a Support plan: Standard/Enhanced/Premium)**
1. Console → **Support → Cases → Create case** (or support.google.com/cloud).
2. Category: **Gemini Enterprise / Vertex AI Agent Builder (Agent Designer / Agent Runtime)**;
   Severity: *Low–Medium* (usability / product-capability question).
3. Paste the **Subject** and **Body** below.

**Route C — no Support plan?** Use the **Gemini Enterprise in-product Help/Feedback**, your
**Google Cloud account/sales rep**, or your **Google Cloud Partner**.

> **File this as a SEPARATE ticket** from the quota and visibility ones — it's an Agent
> Designer / Agent Runtime product question.

---

## Subject
Migrated / API-created agents cannot be opened in Agent Designer; ADK (Agent Runtime)
deployments have no edit option in the console — is there a supported way to edit them in
Google's UI, or is this a platform limitation?

## Body

**Project details**
- Project ID: `studio-enterprise-migration`
- Project number: `231705905417`
- Edition: **Gemini Enterprise Standard**
- Engine/App: `gemini-enterprise-17847887_1784788734248`
- Location: `global`
- API: Discovery Engine `v1alpha`; ADK agents deployed via Vertex AI Agent Engine (Reasoning Engine)

**What happens**
Agents created programmatically (via API migration) cannot be edited in Google's visual UI:
- The per-agent ⋮ menu offers only **Preview / Delete** — there is **no "Edit"**.
- **"Open in Agent Designer" fails** for API-created low-code agents.
- **ADK-deployed agents do not appear in Agent Studio's list at all** — they show only under
  **Deployments (Agent Runtime)**, which has **no visual flow editor** and **no edit option**.

Our understanding (please confirm or correct): the visual designer only opens agents that were
**created interactively inside it**, so any agent created via API is not registered as a
designer draft and cannot be loaded. For **ADK** agents specifically, the behavior
(instruction/tools/model) lives in the separately-deployed **Reasoning Engine**, not on the
agent resource — so even the API edit path requires an `agent_engines.update` / redeploy
rather than a simple `agents.patch`.

**What we've verified via the API**
- `PATCH updateMask=displayName,description` → **200** (metadata editable in place).
- `PATCH updateMask=lowCodeAgentDefinition` (modified instruction) → **200** (low-code
  behavior patchable in place, no redeploy).
- `PATCH updateMask=state` → **400 "immutable path 'state'"**.
- ADK behavior changes require updating/redeploying the reasoning engine (not a `patch`).

**Our questions**
1. Is there any supported way to **open and edit a migrated / API-created agent in Agent
   Designer / Agent Studio** (low-code and/or ADK)? If so, what registers an agent as
   designer-editable?
2. For **ADK / Agent Runtime** deployments specifically, is there any **in-console edit**
   capability planned, or is `agent_engines.update` / redeploy the only supported path to
   change behavior?
3. If editing migrated agents in Google's UI is **not** currently possible, please confirm
   that this is expected platform behavior and whether it is on the **roadmap**.

**Business context**
We provide editing to customers through our own no-code "Edit Agent" screen (which calls
`agents.patch` for low-code and `agent_engines.update` for ADK under the hood), so this is not
blocking. We're confirming Google's supported story so we set correct expectations with
customers and don't design around a capability that may or may not arrive.

---

## After you hear back — record the answer here
- Edit-in-Designer possible? _____ (low-code / ADK)
- ADK in-console edit — planned? _____
- Confirmed platform limitation vs roadmap: _____

(Fill this in — it updates `LIMITATIONS-EDITING-AGENTS.md` §6 "Future note.")
