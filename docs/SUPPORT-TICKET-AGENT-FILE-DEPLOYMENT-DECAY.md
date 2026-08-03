# Google Support Ticket — low-code agent's deployed revision disappears / never appears

Reusable draft to report that `lowCodeAgentDefinition.deployedNodes` (the actual runnable,
published revision of a low-code agent) either never gets created after a successful
`:publish` call, or spontaneously disappears from an agent that previously had it — with zero
edits made in between. Either way, the agent then fails to answer **every** message (not just
file-related ones) with a generic `"Something went wrong while answering your question."`

---

## How to submit it (pick the route that matches your access)

**Route A — Cloud Support case (needs a Support plan: Standard/Enhanced/Premium)**
1. Console → **Support → Cases → Create case** (or support.google.com/cloud).
2. Category: **Gemini Enterprise / Vertex AI Agent Builder (Discovery Engine)**; Severity:
   *High* — affected agents are completely unusable in production, not degraded.
3. Paste the **Subject** and **Body** below.

**Route B — no Support plan?** Use the **Gemini Enterprise in-product Help/Feedback**, your
**Google Cloud account/sales rep**, or your **Google Cloud Partner** to route it.

---

## Subject
Low-code agent's `deployedNodes` (published revision) never appears after `:publish`, or
disappears over time with no edits — agent then fails on every message, including "hi".

## Body

**Project details**
- Project number: `521161651560`
- Engine/App: `agentspace-engine`
- Assistant: `default_assistant`
- Location: `global`
- API: Discovery Engine `v1alpha`
- Auth: service account via Domain-Wide Delegation, impersonating `mia@cloudfuze.com`
- Edition: not yet confirmed on our side — please advise if this is edition-specific
  (Business vs. Standard/Plus)

**What happens (two related symptoms, same underlying field)**

1. **A freshly created + published agent never gets a deployed revision.** We create a
   low-code agent (`POST .../assistants/default_assistant/agents`), then call
   `POST .../agents/{agentId}:publish` with an empty body `{}`. The call returns `200 OK` with
   a full agent object in the response — but the agent's `lowCodeAgentDefinition` only ever
   has `nodes`/`rootAgentId` (the draft), **never** `deployedNodes`/`deployedRootAgentId`. We
   called `:publish` again twice more, minutes apart, on the same agent — same `200 OK`,
   still no `deployedNodes`, and critically **the agent's `updateTime` never changed across
   any of the three publish calls**, proving the call is a true no-op, not a propagation delay.
   - Affected agent: `12427558775331660041` ("CloudFuze Studio Migrate"), created
     `2026-08-02T04:08:17Z`. `updateTime` frozen at `2026-08-02T04:08:46Z` through three
     separate `:publish` calls over the following ~15 minutes.

2. **A previously-working agent's `deployedNodes` disappears on its own, with no edits made.**
   We captured this agent's full JSON on `2026-08-02` (~04:12 local) — `deployedNodes` and
   `deployedRootAgentId` were both present and populated. We re-fetched the exact same agent
   ~16.5 hours later (`2026-08-03` ~20:34 local), with **zero API calls or UI edits to this
   agent in between** — `deployedNodes` and `deployedRootAgentId` are now both absent.
   - Affected agent: `6194100155069336762` ("Service Operations Agent"), `state: PRIVATE`,
     one file attached (`Instructions.txt`).

**Effect on end users:** every agent currently missing `deployedNodes` fails to answer *any*
message in the real, published chat UI — including trivial ones like `"hi"` — with:
```
Something went wrong while answering your question. Please try again later.
```
This is not limited to questions that require the attached knowledge file; a bare greeting
fails identically.

**What we have already ruled out**
- **Not our upload code.** We reproduced this on an agent where the file was attached
  *manually through the Gemini Enterprise UI itself* (not our API), confirming the missing/
  decaying `deployedNodes` is unrelated to how the file got attached.
- **Not a propagation delay.** Re-publishing and waiting (including a second manual test
  minutes later) never changed the outcome, and `updateTime` staying frozen across multiple
  `:publish` calls proves the server did no work, not that it needed more time.
- **Not about file type, filename encoding, or file count.** Reproduced across `.txt`, `.pdf`,
  and `.xlsx`, with 1–2 files, and with both correctly- and incorrectly-encoded filenames.
- **Correlates with `state`, not fully explained by it.** The one agent in our project that has
  kept its `deployedNodes` intact for multiple days (`CS_GE Knowledge Test Agent`,
  `11213382165064235953`) is `state: ENABLED`. Every affected agent is `state: PRIVATE`. We
  don't know if `PRIVATE` agents are simply not intended to stay deployed without periodic
  re-publishing, or if this is an unintended bug.

**Our questions**
1. Is `deployedNodes` on a `PRIVATE`-state low-code agent expected to expire/decay over time
   without periodic re-publishing? If so, what is the actual TTL, and is there a supported way
   to keep it alive (a no-op re-publish on a schedule, a "keep warm" setting, etc.)?
2. Why does `:publish` return `200 OK` with an unchanged `updateTime` and no `deployedNodes`
   for agent `12427558775331660041` — is there a required field in the `:publish` request body
   we're missing (we currently send `{}`), given this method isn't in the public REST reference
   at all?
3. Is moving affected agents to `state: ENABLED` a supported way to avoid this, or is that
   state reserved for something else (e.g., gallery visibility) and not meant as a workaround?

**Our request**
Please investigate why `deployedNodes` is either never populated after a successful-looking
`:publish`, or disappears from a previously-working agent with no edits, and provide a fix or
a documented, supported way to keep a `PRIVATE` low-code agent's deployed revision stable. This
currently makes any low-code agent with a knowledge file attached unreliable for production use
on an unpredictable timescale (hours to days).

**Business context**
This is a commercial migration tool that creates low-code agents (with attached knowledge
files) on behalf of customers, unattended. An agent that answers correctly right after
migration but silently stops answering *anything* within a day, with no code change or user
action, is a serious reliability problem for a customer-facing migration.

---

## Live diagnostic evidence (2026-08-02 → 2026-08-03)

**Agent A — never deployed at all:**
```
agentId: 12427558775331660041 ("CloudFuze Studio Migrate")
createTime: 2026-08-02T04:08:17.783129Z
Publish call #1 (during migration):  200 OK, updateTime → 2026-08-02T04:08:46.967187141Z
Publish call #2 (manual, ~04:16):    200 OK, updateTime UNCHANGED (04:08:46...)
Publish call #3 (manual, ~04:21):    200 OK, updateTime UNCHANGED (04:08:46...)
lowCodeAgentDefinition keys after call #3: nodes, rootAgentId, draftDisplayName, draftIcon,
  draftDescription, agentFiles, draftStarterPrompts — no deployedNodes, ever.
```

**Agent B — deployed, then decayed with no edits:**
```
agentId: 6194100155069336762 ("Service Operations Agent"), state: PRIVATE
2026-08-02 ~04:12 local — GET agent: deployedNodes PRESENT (full node populated),
  deployedRootAgentId: "root_agent"
2026-08-03 ~20:34 local (~16.5h later, zero calls/edits to this agent in between) — GET agent:
  deployedNodes: (absent), deployedRootAgentId: (absent)
```

**Control — the one agent that has stayed stable:**
```
agentId: 11213382165064235953 ("CS_GE Knowledge Test Agent"), state: ENABLED
Created 2026-07-30. Checked again 2026-08-03 (3 days later): deployedNodes still present.
```

## After you hear back — record the answer here
- Is `PRIVATE`-state decay expected/by design? _____
- Supported keep-alive mechanism, if any: _____
- Root cause of the `:publish` no-op on Agent A: _____
- Recommended `state` for production knowledge-grounded agents: _____
