# Google Support Ticket — Low-code agents stay PRIVATE (not listed in org gallery)

Reusable draft to ask Google how to **programmatically promote/enable a low-code
(Agentspace) agent to the org gallery** on Gemini Enterprise **Standard/Plus**, or to
confirm it isn't currently possible. Re-use per customer project by swapping the
**Project details** block.

Companion analysis: `GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md` (root cause + full test matrix).

---

## How to submit it

**Route B — Cloud Support case (needs a Support plan: Standard/Enhanced/Premium)**
1. Console → **Support → Cases → Create case** (or support.google.com/cloud).
2. Category: **Gemini Enterprise / Vertex AI Agent Builder (Discovery Engine)**; Severity:
   *Medium* (blocking end-user visibility of migrated agents).
3. Paste the **Subject** and **Body** below.

**Route C — no Support plan?** Use the **Gemini Enterprise in-product Help/Feedback**, your
**Google Cloud account/sales rep**, or your **Google Cloud Partner** to route it.

> **File this as a SEPARATE ticket from the quota one** — it goes to the Agentspace
> *product* team, not the Discovery Engine infra/quota team.

---

## Subject
Low-code (Agentspace) agents created via API stay in `state: PRIVATE` on Gemini Enterprise
Standard — no API path or console action found to promote them to `Enabled` / the org gallery.

## Body

**Project details**
- Project ID: `studio-enterprise-migration`
- Project number: `231705905417`
- Edition: **Gemini Enterprise Standard** (subscription `68f8b28b-93ac-4dd5-b229-255ff66b4946`)
- Engine/App: `gemini-enterprise-17847887_1784788734248`
- Location: `global`
- API: Discovery Engine `v1alpha`

**What happens**
Low-code agents created via the API exist in the engine (the console Agents view lists them)
and open via direct agent link
(`vertexaisearch…/cid/<cid>/r/agent/<agentId>` → New chat), but they stay in
**`state: PRIVATE`**. As a result they are **NOT listed** in the web-app Agents gallery
("From your organization" / "Your agents"), and the console offers **no Enable action** for
them (the per-agent ⋮ menu shows only **Preview / Delete**; the "Agent Settings" gear
controls only third-party Marketplace visibility, not employee-made agents).

**What we've already tried (all failed — tested against the live API)**
- `PATCH state=ENABLED` → **400 immutable** ("immutable path 'state'")
- `PATCH state=PUBLIC` → **400 invalid value**
- `:enable` → **404**
- `:deploy` → **400**
- `:publish` → **200**, but the agent stays `PRIVATE`
- Create-with `state: ENABLED` → **coerced back to `PRIVATE`** (confirmed on Business edition;
  untested on Standard only because the agent-creation quota is exhausted)

We have also ruled out identity, IAM role (`roles/discoveryengine.agentspaceUser`), agent
validity, propagation delay (24h+), and ownership as causes — see companion analysis.

**Our questions**
1. How do we **programmatically promote/enable a low-code (Agentspace) agent to the org
   gallery** on Standard/Plus? Is there an API field, endpoint, or admin/console step?
2. If `state` is server-controlled, what is the **supported mechanism** to make an
   API-created low-code agent discoverable to end users in the web-app gallery?
3. If there is **no** current mechanism, is this on the **roadmap**, and what is the
   recommended interim path for end-user discovery?

**Business context**
This is a repeatable enterprise workload (Microsoft Copilot Studio → Gemini Enterprise
migration). Migration itself works (agents deploy, share `ALL_USERS`, verify), and agents are
usable by direct link — but for real Standard/Plus customers the **org-gallery listing** is
what end users rely on to find their agents. This is the common case, since customers
migrating from Copilot Studio are mid-to-large enterprises on Standard/Plus (not Business).

---

## After you hear back — record the answer here
- Promote/enable mechanism: _____
- API field/endpoint (if any): _____
- Roadmap status (if none today): _____
- Recommended interim path: _____

(Fill this in — it closes the "production gap" in `GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md` §6.)
