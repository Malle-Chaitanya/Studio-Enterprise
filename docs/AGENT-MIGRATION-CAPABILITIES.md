# Agent Migration — Capabilities & Limitations (Sales / Marketing Note)

**Audience:** Sales, Marketing, Solution Consultants.
**Purpose:** What we CAN promise, what needs a manual step, and what we must NOT promise
for **Copilot Studio → Gemini Enterprise** agent migration.
**Principle:** honest by design. Overclaiming a migration is a trust failure, not a demo win.
**Last updated:** 2026-07-29. **Evidence basis:** live API probe of a real Business tenant
+ official Google API schema/changelog + official Microsoft Dataverse docs (see “Evidence” at end).

---

## TL;DR for a sales call

> “We migrate your Copilot Studio agents into your own Gemini Enterprise with high fidelity —
> the agent’s instructions, conversation logic, starter prompts, and uploaded knowledge files —
> and we show you a per-agent report of exactly what carried over. To make each agent live to
> your whole org, an admin clicks **Publish/Create** once per agent in Gemini (Google doesn’t
> expose an API to do that step yet). We map who owned/could-access each agent and give your
> admin a pre-mapped checklist to reproduce granular access, because Google’s API only supports
> org-wide sharing today.”

Do not go beyond that without checking this doc.

---

## ✅ What we CAN do (sell with confidence)

- **Extract agents with high fidelity** from Copilot Studio: real instructions **verbatim**,
  custom **topics compiled into followable “Conversation procedures,”** starter prompts,
  and **uploaded knowledge files** attached to the agent.
- **Create the agent in the customer’s own Gemini Enterprise** (their project + app), discovered
  live at runtime — nothing hardcoded, works against any customer project.
- **Share org-wide automatically** (`ALL_USERS`) via API.
- **Per-agent fidelity report**: what mapped fully, what needs review, what was lost — honestly.
- **Capture the source ownership & access list** (owner, shared users, chat-access policy) and
  **report it**, so the customer sees who had access before anything is written.
- **Works on both editions** (Business and Standard/Plus) for the migration itself.
- **Idempotent & resumable**: re-running doesn’t re-extract; a failed run is retryable.

## ⚠️ What needs a MANUAL step (set expectations up front)

- **Publishing an agent so the org can see it.** Migrated agents land in **`PRIVATE`** state
  (visible only to the creator/admin). An admin must click **“Create”/Publish** in the Gemini UI
  **once per agent** to make it live to users. *(Google removed the API that used to do this —
  see below. This is a Google limitation, not ours.)*
- **Granular per-user / per-group access.** We map the users, but applying anything narrower than
  org-wide is done in the Gemini console/UI. We hand the admin a **pre-mapped checklist** (which
  Google users/groups to add, and where to click).

## ❌ What we CANNOT do today (do NOT promise this)

- **Auto-publish/enable agents via API.** Google **removed** the enable API (Feb 2026); agent
  `state` is immutable via API. So we cannot flip an agent to “live” programmatically.
- **Set per-user or per-group agent permissions via API.** The API supports **only org-wide
  (`ALL_USERS`)**. Per-user sharing exists **only in the Gemini console/UI**.
- **Set or transfer agent ownership to a specific person.** Ownership follows whoever created it
  (our service account / the admin). No API to reassign it.
- **Preserve granular permission *levels*** (view vs edit vs manage). Gemini agents have no
  multi-level access list — it’s essentially “can access” or not.
- **Rebuild external tool/connector actions** used inside topics (Power Automate / connectors).
  We describe them and flag them for manual rebuild.
- **Migrate non-file knowledge** (websites, Dataverse, SharePoint) into Gemini Knowledge — the
  data-store path isn’t wired; we report these honestly.
- **Flows / workflows.** Phase 1 is **agents only**.

---

## By edition — what the customer will experience

| | **Business** (SMB / self-serve) | **Standard / Plus** (enterprise) |
|---|---|---|
| Migration runs | ✅ Yes | ✅ Yes |
| Migrated agent visible to the **admin/owner** | ✅ Immediately (as a `PRIVATE` draft) | ⚠️ Exists; usable by direct link |
| Visible to **other org users** | After a manual **“Create”/Publish** per agent | ⚠️ Blocked — governed gallery lists only enabled agents, and there’s **no self-serve enable** |
| Auto org-wide (`ALL_USERS`) | Set, but inert until published | Set, but agent won’t list until enabled |
| Granular per-user share | Manual, in **Agent Designer** share dialog | Manual, in **Cloud Console → User permissions** |
| Net honest positioning | “Great fit — one publish click per agent and your team sees them.” | “Migration + report works; org-wide UI listing needs Google’s enable step (roadmap). Set this expectation.” |

**Takeaway:** **Business is the smoother demo/story.** Standard/Plus has an extra Google-side
gap (gallery listing) that isn’t in our control — always set that expectation for enterprise deals.

---

## The two things that trip people up (explain these clearly)

### 1. Agent “status” — why a migrated agent may not show for everyone
Every Gemini agent has a **state**. The two that matter:
- **`PRIVATE`** = *available only to its creator*. Migrated agents start here. This is why a
  teammate (non-admin) doesn’t see it yet.
- **`ENABLED`** = *available to users who have access*. This is “live to the org.” Reaching it
  today requires the **manual Publish/Create** click.

We map the source’s status honestly:
- Agent was **unpublished/draft** in Copilot → stays **`PRIVATE`** in Gemini (correct — no action needed).
- Agent was **published/live** in Copilot → we set `ALL_USERS` and **flag it “Publish this”** in the
  handoff, so the admin only has to enable the ones that were actually live.

### 2. Permissions — “same people keep access” is not fully automatable
- We **read** the source access list (owner, shared users, who could chat) and **report** it.
- We **map** those users to their Google identities.
- We **apply** org-wide access automatically; **granular access is a guided manual step** (checklist),
  because Google’s API only does org-wide today.
- So the honest promise is: **“we capture and map every agent’s access and give your admin a
  pre-mapped checklist to reproduce it”** — NOT “we replicate per-user permissions automatically.”

---

## Roadmap / pending Google (say “planned,” not “available”)
- **Auto-publish/enable** migrated agents (blocked on Google restoring an enable API — filed as a request).
- **Automated per-user/per-group permission apply** (blocked on Google exposing a per-principal
  agent-sharing API). Our design already computes the exact target — it flips to automatic the day
  Google ships the API, with no rework.
- **Non-file knowledge sources** and **flows/workflows** — future phases.

---

## Evidence (so this is fact, not opinion)
- **Live probe** of a real **Business** tenant (project `521161651560`): two migrated agents with
  identical `sharingConfig: ALL_USERS` but different `state` — one `ENABLED` (published via UI,
  visible to a second user), one `PRIVATE` (never published, invisible to others). Proves
  visibility is gated by `state`, not sharing, and that publish is a manual UI step **on Business**.
- **Official Google API schema** (Discovery Engine v1alpha discovery document): the `Agent.state`
  enum — `PRIVATE` = “available only to its creator,” `ENABLED` = “available for users who have access.”
- **Official Google changelog (2026-02-10):** `enableAgent`/`disableAgent`/`suspendAgent` methods
  **removed**; `enableAgent` now returns 404. `state` immutable via PATCH.
- **Official Microsoft Dataverse `bot` docs:** source status = `statecode` (Active/Inactive) +
  publish snapshot (`publishedon`, `PvaPublish`); access via record sharing + `accesscontrolpolicy`.
- Deeper technical detail: see [GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md](GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md),
  [GEMINI-CHATBOT-CLAIMS-FACTCHECK.md](GEMINI-CHATBOT-CLAIMS-FACTCHECK.md),
  [design/permission-mapping.md](design/permission-mapping.md).

---

## One-line rules for the team
- **Never** say “agents automatically go live to everyone.” Say “one publish click per agent (Business).”
- **Never** say “we replicate exact per-user permissions.” Say “we map access and give a pre-mapped checklist.”
- **Never** promise Standard/Plus gallery listing without noting Google’s enable gap.
- **Always** lead with the strong, true part: high-fidelity agent + topics + knowledge + honest report.
