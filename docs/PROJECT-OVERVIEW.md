# CloudFuze Studio Migrate — Project Overview

A plain-English explanation of what this project is, what it does, and what is and
isn't covered right now. For the deep technical walkthrough (file/line references,
exact behavior) see [how-it-works.md](how-it-works.md). For what's proven true in
production vs. just written in code, see [verification-ledger.md](verification-ledger.md).

## What this is, in one paragraph

Companies build chatbots ("agents") in **Microsoft Copilot Studio**. Some of those
companies want to move to **Google Gemini Enterprise** instead — a different chatbot
platform, from a different vendor. Doing that by hand means someone re-typing every
agent's instructions, re-connecting every knowledge source, and re-building every
integration (Jira, Confluence, SharePoint, etc.) from scratch, agent by agent. **This
tool automates that move.** A customer connects both platforms, picks which agents to
bring over, and the tool reads each one out of Microsoft's system, rebuilds it inside
Google's system, and reports exactly what came across faithfully and what didn't.

## Who it's for

- **The customer** — an organization migrating off Copilot Studio. They provide two
  admins: a **Microsoft admin** (grants access to their Copilot/Dataverse data) and a
  **Google admin** (identifies the destination Gemini Enterprise project).
- **CloudFuze** — runs the tool as a service. It's built to work against *any*
  customer's setup unchanged — nothing about a specific customer is hardcoded.

## How a migration actually runs (the user's view)

The web app walks the customer through six steps:

```
Connect Platforms → Choose a Pair → Select & Map → Select Data → (Dry Run) → Live Migration → Report
```

1. **Connect** — the customer signs into both Microsoft and Google.
2. **Choose a pair** — which Copilot environment, which Gemini project.
3. **Select & map** — pick which agents to migrate.
4. **Select data** — decide how each agent's knowledge sources (files, wikis, SharePoint
   folders, etc.) should be rebuilt on the Google side.
5. **Dry run** *(optional)* — see exactly what would happen, with nothing actually
   created in Gemini yet.
6. **Live migration** — the tool builds and deploys each agent for real, publishes it,
   shares it with the right people, and asks it a real question to confirm it works.
7. **Report** — a per-agent scorecard: what was migrated faithfully, what changed,
   and what needs a human to look at.

Behind the scenes this is two separate stages — **extract everything from Microsoft
first, then build everything in Google second** — so that if the second stage fails
partway through (quota limits, a flaky API call), it can be retried without having to
re-read Microsoft's data from scratch.

## What's in scope right now

**Phase 1 = agents only, and the goal is high fidelity** — the migrated agent should
behave like the original, not just superficially resemble it. Concretely, in scope:

- The agent's instructions (its "personality" and rules), read from the real source —
  not guessed or reconstructed.
- Its topics/conversation flows.
- Its knowledge sources (uploaded files, SharePoint, Confluence, structured data
  tables), rebuilt the closest equivalent way on the Google side.
- Its tools/integrations (Jira, HubSpot, Teams, Dropbox, Salesforce, SharePoint, and
  hundreds more). A dynamic connector registry reads each connector's real, live
  definition straight from Microsoft's own API instead of hardcoding a fixed list —
  281 connectors captured so far, 150 of them already producing a real working
  migrated tool, and more coming online as they're verified. See
  [DYNAMIC-CONNECTORS-RESEARCH.md](DYNAMIC-CONNECTORS-RESEARCH.md).
- **Agent Flows** — a Power Automate flow that one of the agent's own actions calls
  (a `kind: 'flow'` tool) is now migrated too, not just described: its real action
  graph is translated into a Google Cloud Application Integration and wired into the
  deployed agent as a genuine callable tool. Anything the translator can't confidently
  reproduce (an unrecognized expression, an unbound connector operation) is spliced
  out and reported as a `FidelityNote`, never silently dropped or guessed at.
- Who owns it and who it's shared with.
- Whether it was published or still a draft.

The customer can choose to migrate one agent, one environment, or an entire tenant —
the process is the same either way.

## What's explicitly out of scope (for now)

Being honest about limits is a product principle here, not an afterthought:

- **Flows as a standalone migration target are not in scope yet.** What's migrated
  today is an Agent Flow *called by an agent* (see above). A flow that stands on its
  own — not tied to any agent, or a full "migrate our flows" wizard step — is still a
  proposed later phase (design written, not yet built as its own feature); see
  [design/FLOWS-PHASE2-ARCHITECTURE.md](design/FLOWS-PHASE2-ARCHITECTURE.md).
- **Per-person access on knowledge sources doesn't carry over.** If a SharePoint
  folder was restricted to one team in the source, the rebuilt version in Gemini is
  not restricted the same way. This is called out to the customer, not hidden.
- **Per-user tool permissions don't carry over either.** If a tool ran "as whoever is
  chatting" in Copilot, it runs as one shared service account after migration —
  broader access, not narrower. The tool detects this today; it doesn't yet fix it.
- **Evaluation/test question sets, disabled components, and Adaptive Card UI** are
  read and mentioned in the report, but not migrated.
- Some Microsoft **prebuilt agents** don't keep their actual logic in a place we can
  read at all — these come across as an empty shell and need a human to author them.
- **Sharing is coarser on the Google side.** Google doesn't offer the same per-person
  sharing controls via API, so narrower access produces a manual checklist for a human
  to apply, instead of silently over-sharing.

None of this is swept under the rug — every gap above shows up in the per-agent
report so the customer knows exactly what to double-check.

## The rules this project won't break

1. **Lossless extraction** — capture everything from the source, even the parts we
   can't yet rebuild on the other side. Nothing is silently thrown away.
2. **Behavioral fidelity** — read what the agent *actually* does, not a guess at what
   it probably does.
3. **Honesty over overclaiming** — the report says what was migrated, what was lost,
   and what needs review. It never makes a migration look better than it was.
4. **Recommend, don't silently decide** — when there's a judgment call (e.g. how to
   handle a knowledge source), the customer is asked, not overridden.

## Current status

Phase 1 (agents) works end-to-end: extract, rebuild, publish, verify, and report all
run today, with progress streamed live to the browser. The main open items are: a
proper automated test suite (testing today leans on scripted probes against a real
tenant), and flows/workflows migration as the next phase. See
[.claude/memory/progress.md](../.claude/memory/progress.md) for the up-to-date list.

## Where to go for more detail

| Question | Read this |
|---|---|
| Exactly how each piece works, with code references | [how-it-works.md](how-it-works.md) |
| What's *proven* in production vs. just implemented | [verification-ledger.md](verification-ledger.md) |
| Current status and known gaps | `.claude/memory/progress.md` |
| Sales-facing summary | [SALES-COPILOT-STUDIO-TO-GEMINI-ENTERPRISE.md](SALES-COPILOT-STUDIO-TO-GEMINI-ENTERPRISE.md) |
| How connector support scales beyond a hardcoded list | [DYNAMIC-CONNECTORS-RESEARCH.md](DYNAMIC-CONNECTORS-RESEARCH.md) |
| How we build and ship changes to this tool | [.claude/rules/aisdlc.md](../.claude/rules/aisdlc.md) |
