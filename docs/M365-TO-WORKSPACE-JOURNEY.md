# From M365 + Copilot to Google Workspace + Gemini

**What the journey looks like, and how much of what you built comes with you.**

Date: 2026-08-19 · Scope: Copilot Studio **agents** · Status: both mail paths proven live (Gmail 15/15, Outlook-on-Graph 14/14)

---

## What this tool does, and does not, move

**It does not move your mail.** No message is copied, indexed or stored anywhere by this
tool. Mailbox migration is a separate project.

**It rebuilds the API call.** Your Copilot agent had a tool that called Outlook. The migrated
agent gets a tool that makes the equivalent call — against Microsoft Graph if your mail stays
in Microsoft 365, or against Gmail if it moves. The mail sits where it already sits; only the
thing calling it changes.

That distinction decides how to read everything below: "Outlook → Gmail" describes which API
the migrated agent talks to, never a transfer of messages.

---

## The short answer

Your **agents** come with you. Most of what they *do* comes with them. Some of what they
*are wired into* does not, and we would rather tell you which parts up front than discover
them together in week six.

For the Outlook mail surface, measured against the real connector rather than a brochure:

There are three different questions here, and merging them into one percentage is how
migration projects go wrong. So:

| | Mail capabilities | Meaning |
|---|---|---|
| **Mapped** | 20 of 23 | We know the Gmail equivalent and the exact limits |
| **Built** | 17 | Code exists |
| **Proven** | 17 | A real call was made against a real mailbox and returned real data |

**What works today**, each one exercised against a live mailbox on 2026-08-19: search, read
a message, list labels, read text attachments, create / edit / list / send drafts, send,
reply (correctly threaded), forward, move to trash, add and remove labels, star, and mark
read or unread.

Every test message was addressed to the mailbox itself and deleted afterwards, so send,
reply and forward were genuinely exercised without a single mail reaching another person.

**What cannot be done at all is 3** — see *What does not come with you* below.

A note on the denominator: 23 is the number of mail capabilities we have analysed, not the
size of the connector. The live Outlook connector is 49 operations spanning mail, calendar,
contacts and rooms. Calendar and contacts are **not analysed and not built**, so a
percentage taken over our own list would flatter us by excluding what we have not yet
looked at.

---

## First, a number worth correcting

The Outlook connector advertises **143 operations**. Taken at face value that implies a
enormous migration. It is not what it appears:

```
143  operations advertised
-89  deprecated (Microsoft's own V1/V2/V3 versions of the same call)
-34  event triggers ("when a new email arrives...")
────
 49  live operations you can actually pick
```

The real surface is **49 operations**, not 143 — roughly a third. Anyone sizing this work
off the advertised number is sizing about three times the reality and will quote a timeline
to match.

---

## What the journey looks like

**Phase 1 — Connect and discover.** You connect your Microsoft tenant and your Google
project. We read your Copilot agents out of Dataverse — instructions, topics, knowledge
sources, connectors — into a neutral representation. Nothing is written to Google yet.

**Phase 2 — Assessment.** You get a per-agent report: what migrates cleanly, what migrates
with limits, what does not migrate, and why. This is where surprises are supposed to happen.
Read it before you approve anything.

**Phase 3 — One-time Workspace grant.** Your Google Workspace admin authorises our service
account to act for your users. This is a real prerequisite, it takes about two minutes, and
**nothing involving Gmail works until it is done.** Details below.

**Phase 4 — Migration.** Agents are created in Gemini Enterprise, their knowledge is
indexed, their tools are rebuilt against Google APIs, and each one is deployed.

**Phase 5 — Verification.** Every migrated agent is asked a real question and its answer is
inspected — including whether its tools actually fired. An agent that deploys but cannot
answer is reported as failed, not as migrated.

---

## What you have to do (the part vendors usually omit)

One item, and it is not optional. In **admin.google.com → Security → Access and data
control → API controls → Domain-wide delegation**, your Workspace admin authorises our
service account's client id with the scopes the migration needs, for example:

```
https://www.googleapis.com/auth/gmail.readonly
```

Two things worth knowing, because both have cost us time:

- **Scope matching is exact.** Granting `.../auth/drive` does not satisfy a request for
  `.../auth/drive.readonly`. Different string, refused token. The grant must list the exact
  scopes.
- **Without it you get `unauthorized_client`**, which reads like a broken integration and is
  actually a missing consent line.

---

## What comes with you

### Reading and searching mail — **works, proven live**

An agent that answered questions about Outlook mail answers them about Gmail. Search by
sender, subject, date, unread state, attachments; read a full message including its body and
attachment names.

Proven 2026-08-19 against a real mailbox: label listing, hydrated search, and full message
read all returned real data.

The narrowing worth stating: Outlook filters by **folder**; Gmail filters by **search query
and labels**. "Unread from Priya last week" maps cleanly. "Everything in the *Q3 Audit*
folder" becomes a label query, and it behaves differently — see below.

### Drafts, sending, replying, organising — **work, proven live**

Create, edit, list and send drafts. Send a new message. Reply in the correct conversation
thread. Forward. Trash, label, star, and mark read or unread.

Sending is real and cannot be undone, so the tools instruct the agent to show you the
recipient, subject and body and get your agreement before sending. That is an instruction
the model follows, not a lock the code enforces — if you want a hard approval gate before an
agent can send mail, say so and we will build one.

### Files and documents — **works**

SharePoint and OneDrive content migrates as indexed knowledge your agent can search — this
works today.

Google Drive live-file tools are built but currently fail on deployed agents with an
authorisation error we are still tracing. Stated here rather than in a footnote, because
"tools exist" would read as "tools work".

---

## What narrows, and exactly how

**Folders become labels.** This is the deepest mismatch and it is structural, not a gap in
our work. An Outlook message lives in exactly **one** folder. A Gmail message carries
**many** labels. Moving a message becomes adding and removing labels. After migration,
"which folder is this in?" has no single answer. Agents that reason about folder structure
need their instructions revisited.

**Flags become stars.** An Outlook flag carries a state and a due date. A Gmail star is a
boolean. Due dates are dropped, not translated.

**Categories lose their colours.** The name survives; the colour does not.

**Replies and forwards are rebuilt.** Gmail threading is header-based, so a reply must carry
the thread id and the right headers or it starts a new conversation. Forwarding has no
primitive at all — the message is re-composed, which means forwarded attachments are
re-uploaded rather than referenced.

**Delete means trash.** We deliberately map delete to trash rather than permanent deletion.
An agent irreversibly destroying mail is a worse outcome than the fidelity gap.

**Shared mailboxes need their own grant.** Google delegation is per-mailbox.

---

## What does not come with you

Five things. Each is stated with its real reason, because "not supported" is not an answer
you can plan around.

**1. Event triggers — 34 operations.** "When a new email arrives, do X." These start a
*flow* when something happens. A migrated agent is request/response: it answers when asked,
and has no event loop.

This one deserves emphasis because it is easy to misread as a Google limitation. **It is
not.** These would be lost migrating Copilot to *any* agent platform, including Microsoft's
own. If event-driven automation is core to your workflows, that is a separate workstream
from agent migration, and you should plan it as one.

**2. MailTips.** Out-of-office status, mailbox-full and external-recipient warnings before
sending. Gmail exposes no equivalent API.

**3. Approval emails and actionable messages.** `SendApprovalMail` and `SendMailWithOptions`
look like email features and are not — they are Power Automate constructs, emails with
buttons wired back to a waiting flow. No vendor has an equivalent, Google included.

**4. AI Builder models.** A trained AI Builder model is your IP, hosted by Microsoft, and
cannot be exported or re-hosted. The agent around it migrates; the model call does not. If
an agent's only real logic is an AI Builder call, expect very little to carry over, and we
will say so in the assessment rather than report a hollow success.

**5. Per-user identity, in its current form.** In Copilot, a connector in Invoker mode reads
*your* mail as *you*. A deployed Gemini agent holds one identity. So a migrated mail agent
reads the mailbox it was configured for, not the mailbox of whoever is asking. For a
team-wide assistant over a shared mailbox this is fine. For "summarise *my* inbox" it is
not, and we will flag it rather than let you discover it in production.

---

## A note on MCP servers

Copilot Studio's tool picker now offers **MCP servers** ("Mail MCP", "Calendar MCP")
alongside individual actions. If your agents use them, read this before estimating.

An MCP server is **one binding to a Microsoft-hosted endpoint**, not a list of operations.
Two consequences:

- **We cannot tell you in advance what it exposes.** The tool list comes from the server at
  runtime, so per-operation fidelity for an MCP-based agent has to be determined by
  inspecting that agent, not read off a table.
- **The server itself does not migrate.** It authenticates against M365 and talks to
  Outlook. Google's agent framework supports MCP, so the *shape* carries over, but the
  destination is our Gmail tools — a re-implementation, not a re-binding.

Where that leaves each one today:

| Copilot tool | Status |
|---|---|
| **Mail MCP** | Reading and searching covered by our Gmail tools. Anything else it exposes needs inspection. |
| **Calendar MCP** | **Not covered** — no Google Calendar tools exist in this product yet. |
| **Contacts MCP** | **Not covered** — no Google Contacts tools yet. |

Microsoft already marks the Mail and Meeting MCP entries deprecated in the connector
definition, so this area is moving. We will re-measure per customer rather than assume.

---

## Not in scope for this tool

**Mail, file and calendar CONTENT migration.** This tool migrates agents — the assistants
you built — not the mailboxes and documents underneath them. Content migration is a separate
exercise.

**Flows and workflows.** Phase 1 is agents only.

**Calendar, contacts and rooms.** 35 calendar, 15 contact and 6 room operations exist in the
connector and are not yet mapped or built. They are counted, not estimated, and they are
honestly listed as unbuilt.

**Teams → Google Chat.** Not yet built. Worth naming plainly because it is the *most used*
Microsoft operation in the agents we have measured (12 of 14 references across 131 agents).
Google Chat needs a Chat app identity, which is a different auth model from mail. It is next,
and it is not done.

---

## How we report fidelity

Every migrated agent gets a report, and the report is allowed to say bad news:

- **mapped** — migrated, nothing lost
- **partial** — migrated with a stated limitation
- **needs-review** — a judgement call a human should check
- **lost** — did not migrate, with the reason

An agent that deploys but cannot answer a question is reported as **failed**. A check we
could not perform is reported as **unverified** — not as success. We would rather hand you
an honest amber than a green that turns out to be theatre.

---

## Current status, stated plainly

| Capability | State |
|---|---|
| Gmail read/search/labels | **Proven live** against a real mailbox |
| Gmail drafts, send, reply, forward, organise | **Proven live** — all 15 tools, 0 failures |
| Outlook mail kept on Microsoft Graph | **Proven live** — all 14 tools, 0 failures |
| Outlook calendar / contacts / rooms | Counted, **not mapped** |
| Teams → Google Chat | **Not built** — highest measured demand |
| SharePoint / OneDrive knowledge | Working |
| Google Drive live tools | Built; a deployment-side auth issue is under investigation |

Both mail paths are proven, so the choice below is real rather than aspirational: an agent
that uses Outlook today can move to Gemini and **keep reading its mail from Microsoft 365**,
or move to Gmail. Neither is assumed for you.

Sending is built on both paths, and that deserves stating plainly rather than burying: a
migrated agent **can send mail in the mailbox’s name**. That is an irreversible outward
action. Every send tool was proven with self-addressed messages only, and whether a given
agent keeps its send tools is a decision the migration surfaces to you per agent — not a
default that ships quietly.

---

*Every number in this document is measured from the actual connector definition or from a
live call. Where something is unproven, it says so.*
