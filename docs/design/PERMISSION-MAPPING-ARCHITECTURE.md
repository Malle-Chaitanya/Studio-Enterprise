# Permission Mapping Architecture — Definitive Reference

**Status:** Consolidated, build-ready. Supersedes the "confirmed real gap" framing in
`permission-mapping.md` §3.2 for the license/engine-role layers — that gap is **closed**
(see §3). Does not replace `permission-mapping.md` (investigation history/citations) or
`environment-and-agent-permission-mapping-plan.md` (environment-role build plan) — this
doc is the one-page picture that ties both together and states what's actually true today.

**Why this doc exists:** across many sessions, external-AI research (a Gemini chatbot)
repeatedly produced plausible-sounding but wrong architecture for this exact problem —
a fabricated IAM changelog quote claiming per-agent `agentViewer`/`agentEditor` roles
exist, an auto-promote-to-project-Editor pattern that directly violates a rule already
encoded in `identityMap.ts:243`, and analysis built on a screenshot of CloudFuze's own
**Agent Migration Hub** UI mistaken for native Copilot Studio. Every claim below is
either shipped code (cited by file:line) or empirically tested and recorded in
`docs/GEMINI-CHATBOT-CLAIMS-FACTCHECK.md`. Nothing here is taken on documentation-prose
authority alone.

---

## 1. The shape of the problem

Two platforms model access on fundamentally different axes. Copilot Studio grants access
**per bot, per mechanism** (chat / co-author / analytics / evaluation), all resolved
against Dataverse security roles and row-shares. Gemini Enterprise grants access on
**three independent, stackable layers** (license → engine/project role → per-agent role),
with exactly one per-agent role that exists at all. A permission-mapping engine's job is
to translate the first into the second **without ever silently over-sharing or silently
dropping a grant** — this project's fidelity-honesty principle applies to security the
same as it applies to instructions or topics.

```
COPILOT STUDIO (source)                          GEMINI ENTERPRISE (destination)
┌─────────────────────────────┐                  ┌─────────────────────────────────┐
│ Environment                 │                  │ GCP Project                     │
│  ├─ System Administrator    │ ───────────────▶ │  ├─ agentspaceAdmin (project)   │
│  ├─ Environment Maker       │ ───────────────▶ │  ├─ agentspaceEditor (project)  │
│  └─ Basic User              │ ───────────────▶ │  └─ agentspaceUser (engine,     │
│                              │                  │       preferred over project)   │
│  Bot (per-agent)             │                  │  Agent (per-agent, one role)    │
│  ├─ Share for chat           │ ───────────────▶ │  ├─ sharingConfig=ALL_USERS, or │
│  │   (individual/group/org)  │                  │  │   agentUser (per principal)  │
│  ├─ Collaborative authoring  │ ──────╳          │  ├─ NO EQUIVALENT               │
│  │   (co-author/editor)      │                  │  │   (needs-review, always)     │
│  ├─ Share Analytics          │ ──────╳          │  ├─ NO EQUIVALENT               │
│  └─ Share Evaluations        │ ──────╳          │  └─ NO EQUIVALENT               │
└─────────────────────────────┘                  └─────────────────────────────────┘
```

The two `╳` groups are not a bug to engineer around — they are a real capability gap in
Gemini Enterprise. The correct behavior is to report them honestly, once, per agent —
never to "solve" them by escalating someone to a project-wide role they didn't have a
project-wide equivalent for on the source side.

---

## 1a. Publish ≠ Share — stated explicitly, on both platforms

This is easy to get subtly wrong (an early piece of external research this project
fact-checked did exactly that — see the intro above), so it gets its own callout instead
of living inside a table footnote:

**Publishing an agent never grants anyone visibility or access, on either platform.**
Publish is a switch on the agent itself (is the live version active?). Share is a
completely separate list (who is authorized at all?). An agent can be fully published and
100% invisible to everyone except its owner — that is the *normal* state for any published
agent nobody has shared yet, not an edge case.

| | Publish answers | Share answers |
|---|---|---|
| Source (Copilot Studio) | Is the live version active on its configured channel (Teams, M365 Copilot, a widget)? | Who can chat with it, or open it in the authoring canvas — Environment Maker alone grants neither by itself |
| Destination (Gemini) | `publishAgent()` (`gemini.ts:160`) — moves the agent toward its active/live content | License + engine-role + `agentUser` grant, or `sharingConfig: ALL_USERS` |

**The one nuance, so this isn't overstated in the other direction — now directly confirmed
by Microsoft, not just inferred:** `learn.microsoft.com/en-us/microsoft-copilot-studio/publication-fundamentals-publish-channels`
(fetched 2026-08-20) states plainly: *"You need to publish your agent before your customers
can engage with it,"* and, critically, frames publish as a **content-freshness** mechanism,
not an access mechanism: *"When you publish an agent, this agent updates on all connected
channels. If you make changes to your agent but don't publish after doing so, your customers
won't be engaging with the latest content."* The entire page is about pushing edited content
to already-connected **channels** (Teams, website, Facebook) — it never once mentions who is
authorized, because that's the Share dialog's job, documented completely separately. This is
Microsoft's own architecture directly confirming the two are independent, not this document's
inference. Concretely: for *chat* access, publish is necessary but never sufficient — a
person on the chat-share list still can't talk to a **draft** agent, because there's nothing
live yet to reach. Share determines *who*; publish determines *whether there's a live version
for authorized people to reach at all*. Collaborative-authoring (Editor) access is the
exception even to that — coauthors work on the draft directly, so publish state doesn't gate
them. (Minor operational nuance from the same page, not relevant to fidelity but worth
knowing: a published update doesn't take effect for a user mid-conversation until their
session ends — up to ~1 hour, or immediately if they type "start over.")

**A third axis this document was missing entirely, surfaced by the same fetch:** agent-level
**authentication mode** — "Authenticate with Microsoft" (default), "Authenticate manually," or
"No authentication." This is independent of both Publish and Share, and it materially changes
what "shared" even means: *"Selecting the No authentication option allows anyone who has the
link to chat and interact with your bot."* An agent set to No authentication makes its Share
list close to irrelevant for real-world reachability — anyone with the link gets in,
regardless of who was ever added to the chat-share list. This has no destination equivalent
worth inventing (Gemini's access model has no analogous "skip identity, just use a link" mode
for chat), so extraction should capture the source agent's authentication mode as another
`needs-review`-worthy fact when it's anything other than the Microsoft-authenticated default —
a `sharedPrincipals` list means little if the agent itself doesn't enforce checking it.

**The sole platform-forced exception to "these are independent":** the ADK/gallery
destination path (§6), where registration returns the agent already `ENABLED`. Google's API
merges publish and org-wide access into one action at registration for this agent type. That
is a platform quirk of one specific agent type, not a reason to weaken the general rule above.

**Correction, live-tested by hand 2026-08-20 — `state: ENABLED` removes the PER-AGENT gate
only, not the license/engine-role gate underneath it.** A prior version of this section
overstated the consequence as "open to literally anyone in the org." A real test disproved
that: a specific person was added via the per-agent "User permissions" dialog on an ENABLED
ADK agent — this had **no effect**; they still could not open it. Only after separately
granting them the engine/project-level `agentspaceUser` role could they actually access and
chat with it. This is the three-layer chain from §3 working exactly as designed — `state:
ENABLED` satisfies layer 3 (per-agent) for everyone, but layers 1 (license) and 2
(engine-role) are untouched and still gate access same as always. **Corrected conclusion:**
an ENABLED ADK agent is reachable by anyone who already holds the engine-level role and a
license — not literally anyone in the organization.

**Second correction, live-tested by hand 2026-08-21 — `sharingConfig` DOES exist on ADK
agents; it just isn't populated by default at registration.** An earlier version of this
section claimed the field "genuinely doesn't exist on ADK agents." That was wrong. Captured
via browser DevTools Network tab, the console's "Add user" dialog uses **two different
mechanisms depending on the Member type radio selected**, both already implemented in this
codebase, neither of them new:
- **User / Group** → `POST agents/{agentId}:setIamPolicy` (the `agentUser` role,
  individual/group members) — this is `grantAgentAccess()`, `gemini.ts:215-262`, unchanged.
- **All users** → `PATCH agents/{agentId}?updateMask=sharing_config.scope`, body
  `{sharingConfig: {scope: "ALL_USERS"}}` — this is `shareAgent()`, `gemini.ts:171-180`,
  **unchanged, and confirmed to work on an ADK agent** (200 OK; a direct re-fetch of the same
  agent immediately afterward shows `"sharingConfig": {"scope": "ALL_USERS"}` in its raw
  body, alongside `adkAgentDefinition` and `state: ENABLED` — it was simply absent before
  anyone had explicitly set it, which is why earlier raw fetches of two *other*, never-shared
  ADK agents showed no such field).

**Correction to a claim made and already retracted in conversation, now fixed here too:**
`grantAgentAccess()`/`ensureAgentAccess()` were said to be "never called in the ADK branch."
False — `orchestrator.ts`'s ADK branch (§6, restricted-permissions case) already calls
`ensureAgentAccess()` and reports per-principal grant success/failure. That automation
already existed; what was actually wrong was the report text describing it (a self-
contradicting handoff reason claiming "Gemini API cannot apply per-user/group sharing" right
above a call that does exactly that) — corrected in the code directly, not just here.

**New open question this raises, genuinely hopeful, not yet tested — do not assume it's
true:** if `sharingConfig` is explicitly settable on an ADK agent, can it also be set to
something *other* than `ALL_USERS`, or removed, to actually narrow an ADK agent's reach after
the fact? If so, "no way to narrow ADK sharing after the fact" (stated elsewhere in this
document, per `orchestrator.ts:2700-2702`'s comment) may itself need correcting. Untested —
the only accepted enum value the earlier fact-check doc confirmed was `ALL_USERS` (`PRIVATE`/
others returned 400 invalid enum on a *low-code* agent); nobody has tried setting or clearing
`sharingConfig` on an *ADK* agent specifically to see if it narrows anything. Test before
relying on either answer.

**Group sharing on ADK agents — fully confirmed end-to-end, three-layer chain intact, live-
tested 2026-08-21.** All three per-agent grant shapes (individual, group, org-wide) were
tested on a real ADK agent, each via a real separate login, not just a console row:
1. Individual (`user:austin@fuzebot.co` via `agentUser`) — confirmed, Austin could open it.
2. Org-wide (`sharingConfig: ALL_USERS`) — confirmed via raw fetch showing the field set.
3. Group — a real Google Group (`geminitestgroup@storefuze.com`, 2 members: Austin, Collins)
   was granted `agentUser` on the agent. Both members could see and presumably open it in
   their own separate logins — real propagation, not a console artifact.

**Critically, a clean isolation test then confirmed the three-layer chain still fully
applies to group-based grants — group membership does not bypass license/engine-role.**
Austin initially still had access after his *project-level* `agentspaceUser` role was
removed — but this was because he *also* held a separate, **engine-level** `agentspaceUser`
binding, invisible on the Cloud Console's main IAM page entirely (project-level and
engine-level IAM are two distinct policies on two distinct resources; confirmed by directly
fetching `engines/{engine}:getIamPolicy`, which showed the binding the console never
displayed). Once that engine-level binding was also removed via `engines:setIamPolicy` —
leaving Austin's *only* remaining path as `geminitestgroup` membership — he was fully locked
out of the entire Gemini Enterprise instance: `"WidgetService.LookupWidgetConfig" error: The
caller does not have permission... does not have access to this Gemini Enterprise instance.`
This is the exact 403 signature already documented in §3 as proof of a missing layer 1/2.
**Conclusion, now verified rather than assumed:** the license → engine-role → per-agent
chain applies uniformly regardless of which mechanism (individual, group, or org-wide)
supplies the per-agent layer. No shortcut exists through group membership.

**Open question, still not verified after actively checking — do not treat as settled:**
`GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` confirms `:publish` does **not** flip a low-code agent's
`state` from `PRIVATE` to `ENABLED` (200 response, state unchanged) — but it never confirms
what `:publish` *does* accomplish for a low-code agent. A live web search plus direct fetches
of Google's Discovery Engine / Agent Search REST reference (2026-08-20) turned up nothing on
this — every page reachable is a navigation index, never the actual field documentation. The
real Agent resource has a separate `activeRevision` field alongside `state`, suggesting
publish may promote a draft revision to live content — a third axis, distinct from both
`state` (gallery listing) and `sharingConfig` (access) — but this remains this document's own
inference from a field name, actively checked against official docs and search and still
unconfirmed either way. Resolve with the diagnostic spike already written
(`server/src/spikes/_diag_probe_publish_effect.ts`) before asserting what publish changes on
this path.

**Correction, live-tested 2026-08-20, replacing an over-broad claim made earlier in this
exact conversation:** it was previously asserted that a `PRIVATE` low-code agent "never
appears in any gallery view, not even as a Draft." That is too strong and has been directly
disproven. A real low-code agent was created via `createAgent()`
(`server/src/spikes/_diag_create_lowcode_gallery_test.ts`, agent id
`11327017899386028767`, confirmed `state: PRIVATE`) and checked live in the Gemini
Enterprise console:

- It **does** appear with a **Draft** badge in **"Your agents"** — the owner's own personal
  list (`zara@storefuze.com`, the creating identity). This makes sense on reflection: you can
  always see your own drafts, the same way Copilot Studio's own maker "My agents" list works.
- It does **not** appear anywhere in **"From your organization"** — the section other members
  of the org would browse to discover shared agents. None of the four agents listed there
  carry a Draft badge, and the new PRIVATE agent is absent from that list entirely. The Share
  dialog for the test agent confirms zero other principals have access — only the owner.

So the two claims that actually matter for this document's security model both survive
correctly: (1) a PRIVATE low-code agent is **not discoverable by anyone else in the org**
through the gallery, and (2) creating one grants **nobody** access by itself, consistent with
§1a's core rule. What was wrong was the stronger, unqualified claim that no UI anywhere shows
any draft state for it — the creator's own personal view does, and that is expected, not a
security concern.

---

## 2. Source model — four independent mechanisms (native Copilot Studio)

Confirmed against `learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots`
(`permission-mapping.md:607-618`). **Do not confuse this with CloudFuze's own Agent
Migration Hub UI** — that product's 3-checkbox dialog (End user / Agent viewer / Editor,
with UI-level mutual exclusivity) is a *different application's* simplification, not
Microsoft's model, and must never be used as the source-of-truth spec for extraction.

| # | Mechanism | Grantable to | Dataverse surface | Extraction status |
|---|---|---|---|---|
| 1 | Share for chat | user / group / org-wide | `ChatBotReaders` (bundled in Environment Maker) | Org-wide/group form: shipped. Individual chat share: unconfirmed — see `permission-mapping.md` §2.1 |
| 2 | Collaborative authoring | individual only | Row-share Write + Environment Maker | Shipped (`decodeAccessMask`'s `hasWrite` → `studioShareRole: 'editor'`) |
| 3 | Share Analytics | **individual only** (confirmed: "you can only share the Analytics viewer role with individuals and not with groups of users" — Microsoft docs, re-fetched 2026-08-20) | Row-share Read + `Analytics Viewer` security role, grants access to the agent's **Analytics** page | Ambiguous — bucketed with #4 today |
| 4 | Share Evaluations | **individual or group** (Microsoft's own share-flow steps say "add a user or group" — this is NOT individual-only, correcting an earlier draft of this table) | `Agent viewer` security role, grants access to the agent's **Evaluation** page, **may carry zero row-share** | Unconfirmed — could be a silent extraction blind spot, not just a mislabel |

**Open item (real, not cosmetic):** whether #3/#4 produce any row-share signal
`readAgentPermissions()` can see, or only a security-role assignment invisible to
`RetrieveSharedPrincipalsAndAccess()`. This determines whether today's fidelity report is
merely mislabeling those two mechanisms or **silently missing them entirely**. Resolve
with a diagnostic spike before trusting the report's Analytics/Evaluation counts: grant
each from the Studio UI to a throwaway user, read `systemuserroles` for that user, diff
`RetrieveSharedPrincipalsAndAccess()` before/after. (`permission-mapping.md` §2.1 — this
plan does not repeat the full method, just flags it as still open.)

**New finding (2026-08-20 doc re-fetch): environment-role assignment is not fully
independent of agent-level sharing on the source side.** Microsoft's current docs state
this plainly for two of the four mechanisms above:
- **Share for chat** can itself grant an environment role: *"Users must have the
  ChatBotReaders privilege to chat with agents in an environment. The Environment Maker
  security role includes this privilege, which is why it's assigned when you share an
  agent with users who don't have sufficient permissions."*
- **Collaborative authoring** requires the coauthor to already hold Environment Maker, and
  if they don't, the sharer (who must be System Administrator) can have Copilot Studio
  assign it to them automatically, as part of the same share action.

This matters for whenever the environment-role feature (§6 item 1) gets built: a person's
Environment Maker role may be a *side effect* of an agent-level share, not an independent
grant someone made deliberately — worth surfacing in the report, not just "this person is
Environment Maker" with no context. Interestingly, this mirrors what `ensureAgentAccess()`
already does on the destination side (§3) — granting per-agent chat access already implies
granting the underlying engine-role first — so the two platforms share this "a narrow grant
implies a broader one underneath it" pattern, just documented on the source side only now.

---

## 3. Destination model — three layers, one already fully shipped further than the docs say

```
  LICENSE                 ENGINE/PROJECT ROLE            PER-AGENT ROLE
 ┌──────────────┐        ┌──────────────────────┐       ┌─────────────────────┐
 │ Gemini Ent.  │  ───▶  │ roles/discoveryengine │ ───▶  │ roles/discoveryengine│
 │ license       │        │ .agentspaceUser       │       │ .agentUser           │
 │ assigned      │        │ (engine-level         │       │ (chat-only — the     │
 │               │        │  preferred)           │       │  ONLY per-agent role │
 │               │        │                       │       │  that exists)        │
 └──────────────┘        └──────────────────────┘       └─────────────────────┘
  listUserLicenses /      engines.setIamPolicy           getIamPolicy(GET) +
  batchUpdateUser-        (etag round-trip)               setIamPolicy(POST),
  Licenses                                                 etag round-trip
```

**Console/IAM display names, confirmed live via `GET iam.googleapis.com/v1/roles/{role}`
2026-08-21 — do not use "Gemini Enterprise User" and "Agent User" interchangeably, they are
two different roles at two different resource levels, both required together, never
either/or:**

| Role ID | `title` (from Google's own IAM API) | `description` | Resource it's bound on |
|---|---|---|---|
| `roles/discoveryengine.agentspaceUser` | **"Gemini Enterprise User"** | *"Grants user-level access to Gemini Enterprise resources."* | Engine (or project) — layer 2 |
| `roles/discoveryengine.agentUser` | **"Agent User"** | *"Grants access to use agents."* | One specific agent — layer 3 |

A principal needs **the license, then both roles** — not one of the two. Missing "Gemini
Enterprise User" (engine-level) 403s with `WidgetService.LookupWidgetConfig` regardless of
a valid per-agent `agentUser` grant (proven in the Austin isolation test below); missing
`agentUser` on a *specific* agent means a licensed, engine-authorized person can open every
*other* agent they're granted on but not that one.

**All three layers are SHIPPED, chained, and already called from both orchestrator sharing
sites.** This corrects `permission-mapping.md` §3.2, which is now stale — it states "this
is not a partial implementation, it's fully unbuilt," but `ensureAgentAccess()`
(`server/src/services/gemini.ts:433-482`) already implements the full chain:

1. Per-user license check (`checkUserLicense`, `gemini.ts:305-336`) — cached via
   `resolvedPrincipalCache` (never caches an `'unknown'` result, so a transient failure
   can't poison future runs as a false-negative).
2. Auto-assign a license if missing (`assignUserLicense`, `gemini.ts:338-360`, calls
   `batchUpdateUserLicenses`) — failure is attributed `failedAt: 'license'`, not silently
   swallowed into a generic error.
3. Engine-scoped `agentspaceUser` grant (`grantEngineUserRole`, `gemini.ts:371-...`, GET
   `:getIamPolicy` → merge → POST `:setIamPolicy`) — `failedAt: 'engine-role'`.
4. Per-agent `agentUser` grant (`grantAgentAccess`, `gemini.ts:215-262`, already covered
   in prior sessions) — `failedAt: 'agent-role'`.

Both call sites already use it: the low-code path (`orchestrator.ts:2811-2817`) and the
ADK/gallery path (`orchestrator.ts:2735-2741`). **Action item: update
`permission-mapping.md` §3.2 to reflect this — it's actively misleading anyone who reads
it as "still to build."** This is the single most consequential correction in this
document; treating a shipped, tested capability as an open TODO risks someone re-building
it, or worse, distrusting a report field that's actually accurate.

**One asymmetry the code currently surfaces, worth naming — but see §1a's 2026-08-21 update,
since this may be more fixable than the code assumes:** the low-code path can restrict
sharing to specific principals (agent is PRIVATE by default, grants are additive). The
ADK/gallery path's `orchestrator.ts` code today does not attempt to restrict sharing at all
after registration (`orchestrator.ts:2700-2702`, "cannot undo via API") — `adkAgentDefinition`
agents come back `state: ENABLED` immediately. §1a now shows `shareAgent()`/`grantAgentAccess()`
both work on ADK agents live-tested, so the open question is whether narrowing (not just
setting `ALL_USERS`) is also possible — untested. Until that's confirmed, treat a restricted
source bot promoted to ADK as still needing a manual console step, reported as `needs-review`,
not silently accepted as "shared."

**Correction, live-tested 2026-08-22 — per-agent grants DO correctly control who can
*discover* an ADK agent, not just who's redundantly listed alongside universal access.**
This section previously implied a per-agent grant on an `ENABLED` ADK agent was close to
meaningless, since `state: ENABLED` alone already lets in anyone with baseline license +
engine role. That claim was based only on direct API/widget reachability tests (§5.2 of the
companion doc) — a genuinely separate real agent's gallery/console behavior was never
actually tested until now. Real test, one agent (WorkMate, a teammate-migrated ADK agent
with no CS_GE involvement, `agents/8561021016517220454`), three sequential real grants, each
verified in the live Google Cloud Console's own "User permissions" table AND in two separate
real people's own "From your organization" gallery view:
1. **Individual** (`agentUser` → austin only) — Austin saw WorkMate in his gallery; Collins,
   with identical license + engine-role standing, did not.
2. **Group** (`agentUser` → geminitestgroup, containing austin + collins) — both saw it.
3. **Org-wide** (`sharingConfig: ALL_USERS`) — Console's own table now literally reads
   "All users" as the member.

Every step matched the grant exactly, with no over- or under-inclusion, across two
independent real logins. **So: gallery/console-visible discoverability for an ADK agent
genuinely does follow the actual grant, not "anyone with baseline access" indiscriminately.**
This corrects the too-strong version of the claim in this document and in
`orchestrator.ts`'s ADK-branch comment (§6 below) — both should be read with this update in
mind, not the original text alone.

**What this does NOT settle, and should not be conflated with the above:** whether a person
with baseline license + engine role but genuinely *zero* per-agent grant can still open an
`ENABLED` ADK agent directly (a raw query/widget call, not the gallery UI) if they somehow
have its agent id/link. That is the scenario the original claim was actually built on
(Email Manager Outlook — zero grants, zero `sharingConfig`, yet reachable via direct
widget-style query by both Austin and Collins) and it has **not** been re-tested since —
attempted a real re-test 2026-08-22 (querying KB-Grounding-Test-Agent, which has an
individual-only grant, as both the granted and an ungranted person) and it was inconclusive:
the request shape failed identically for both, meaning it was a malformed-request problem, not
a permission signal either way. Gallery discoverability and direct-link reachability remain
two different, separately-evidenced mechanisms; only the first is confirmed to respect grants.

**Decision, 2026-08-22 — `guardAgainstRestrictedSharingOnAdk` removed, a deliberate scope
choice, not a claim that the direct-reachability concern was disproven.** The guard routed a
restricted-sharing fresh agent to low-code instead of ADK specifically to guard against the
still-unconfirmed direct-link-bypass scenario above. Removed because: (1) this tool's actual
sharing requirement is that the Gemini Enterprise UI shows the agent to the right people —
now proven correct on ADK across all three shapes; (2) the guard was routing restricted-
sharing agents to low-code, whose own per-agent grant mechanism is confirmed **broken** for
exactly the individual/group case (`setIamPolicy` on a private agent → `FAILED_PRECONDITION`,
§3.5) — so the guard was steering agents toward the path that doesn't work, to protect
against a narrower risk that was never conclusively confirmed either way. If a future
requirement needs to prevent direct-link bypass specifically (not just correct gallery
listing), re-resolve the open question above with a real browser test before reintroducing
a guard — don't assume the old rationale still applies unmodified.

### 3.0.1 Live end-to-end validation, 2026-08-21 — all three sharing shapes, real migrated agents, real production code

Everything in §3 was previously validated with throwaway test agents and console-driven
clicks. This run instead called the actual shipped functions from `gemini.ts` — the same
ones `orchestrator.ts` calls — against three real, already-migrated, `ENABLED` ADK agents
in the `studio-enterprise-migration` tenant, one per sharing shape, then verified each via
a raw `getIamPolicy`/agent-body fetch. Script: `server/src/spikes/_diag_real_sharing_via_code.ts`
(+ `_diag_real_sharing_individual_retry.ts`, `_diag_confirm_adk_and_enable_timing.ts`).

| Sharing shape | Agent (all confirmed genuine ADK, real `provisionedReasoningEngine`, `state: ENABLED` since original migration — not caused by this test) | Function called | Granted to | Verified via | Result |
|---|---|---|---|---|---|
| Individual | Teams Coordinator (`agents/18100528233420232026`) | `ensureAgentAccess({users:[...]})` | `user:austin@fuzebot.co` | `agents/{id}:getIamPolicy` | ✅ `roles/discoveryengine.agentUser` bound |
| Group | SharePoint Connector Agent (ADK) (`agents/8251121235349690669`) | `ensureAgentAccess({groups:[...]})` | `group:geminitestgroup@storefuze.com` | `agents/{id}:getIamPolicy` | ✅ `roles/discoveryengine.agentUser` bound |
| Org-wide | CloudFuze Studio Migrate (full: docs + live + topics) (`agents/1326005160808304638`) | `shareAgent()` | `sharingConfig.scope = ALL_USERS` | raw agent GET | ✅ persisted, alongside `state: ENABLED` and the real `adkAgentDefinition` |

**Operational finding worth remembering for any future scripted test against this tenant:
agent IDs are not stable across re-migrations.** The first pass used a "Teams Coordinator"
id recorded in an earlier session (`3490661072028616401`) and got a confusing failure —
`ensureAgentAccess`'s internal `setIamPolicy` returned `400 "Policy etag is required"`,
which looks like a code bug on first read. It wasn't: that id no longer exists at all (a
direct `getIamPolicy` on it 404s — `"Agent ... does not exist"`). Google rejects the
malformed request (no etag, because the preceding `getIamPolicy` 404'd and the code moved
on with an empty etag) before it ever gets to checking whether the resource exists, so the
error surfaces as a 400 about etags rather than a 404 about the agent — a red herring.
Re-pulling the current id via `_diag_agents.ts` (`18100528233420232026`) and retrying
immediately succeeded. **Lesson: always re-verify an agent id live before scripting against
it — never reuse one recorded from a prior session or doc, this tenant's ids shift under
re-migration.**

**Confirms, with real production code rather than a throwaway agent, everything §3 already
claimed:** `ensureAgentAccess()` correctly performs the full license → engine-role →
agent-role chain for both individual and group grants on ADK agents, and `shareAgent()`
correctly sets org-wide access — no gap found in either code path when run against real
migrated data end to end.

### 3.1 ADK agents specifically have a SECOND, separate sharing layer — confirmed via official docs (2026-08-20)

Everything above (license → engine-role → `agentUser`/`sharingConfig`) is **Layer A**: access
through the Gemini Enterprise web app. For ADK agents there is also **Layer B**, direct API
access to the raw agent, and it is a genuinely different mechanism, not another name for the
same thing:

| | Layer A — Gemini Enterprise web app | Layer B — direct Reasoning Engine API |
|---|---|---|
| Resource | Discovery Engine `agents/{agentId}` | Vertex AI `reasoningEngines/{id}` |
| Mechanism | `agentUser` role via `setIamPolicy` (individual/group, both agent types — confirmed live on an ADK agent 2026-08-21), or org-wide via `sharingConfig: ALL_USERS` PATCH (both agent types — also confirmed live on ADK 2026-08-21, see §1a; simply unset by default on ADK, not absent as a field) | A **custom role** containing only `aiplatform.reasoningEngines.query` |
| Principals supported | User or group | **User or service account only — no group support** (confirmed: official docs make no mention of group-based sharing for this mechanism) |
| What it grants | Chat with the agent inside the app/gallery | *"Direct access to send messages to the agent's FastAPI endpoint"* — bypasses the app entirely |
| Confirmed independent? | — | Yes — the Layer B doc (`govern/share-agent`) makes **zero reference** to Discovery Engine, `agentUser`, or `sharingConfig`; the ADK registration doc separately confirms Layer A sharing is documented as its own distinct step ("To allow users to access an agent using the Gemini Enterprise web app, see Share an agent") |

**Why this matters for the mapping:** Layer B has no Copilot Studio equivalent worth
inventing — the closest analog (Direct Line API keys for programmatic bot access) is a
different, non-IAM mechanism entirely, not a real match. Layer B is only relevant if a
customer's source agent has programmatic/service consumers calling it directly (bypassing
Copilot Studio's own chat surface) — the honest move is to name this as an explicit,
out-of-scope gap in the report if such a consumer is detected, not to silently ignore it or
force-fit it into the `agentUser`/chat-sharing model, which does not cover it.

Sources: `docs.cloud.google.com/gemini-enterprise-agent-platform/govern/share-agent`,
`docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-adk-agent` (both
fetched directly, not inferred).

**Confirmed live in the console, 2026-08-20 — Layer B is a real, separate admin surface, not
just docs prose.** Google Cloud Console's **Agent Platform > Agents > Deployments** page (the
raw Vertex AI Agent Runtime / Reasoning Engine list — a different resource entirely from the
Discovery Engine `agents/{agentId}` this whole document otherwise discusses) shows each
deployment with its own service-account **Identity** column, and a **Service configuration >
Access & Permissions** tab stating plainly: *"Agent permissions are managed via IAM on the
associated Service Account."* This is the console's own UI for Layer B — it exists as a real
feature, confirming (not just describing) the `aiplatform.reasoningEngines.query` mechanism
from the official docs above. Practical implication: **there are three separate admin
surfaces for one ADK agent**, not two — (1) the Gemini Enterprise consumer app (chat, governed
by `state: ENABLED`), (2) the Discovery Engine "Agent Registry" per-agent `agentUser` list
(§3 above), and (3) this Reasoning Engine deployment's own IAM/service-account permissions
(Layer B). None of the three imply or grant the others.

---

## 4. Project/environment-level roles (confirmed, per `environment-and-agent-permission-mapping-plan.md` §4)

| Source role | Destination role | Scope | Grant discipline |
|---|---|---|---|
| System Administrator | `roles/discoveryengine.agentspaceAdmin` | Project | **One at a time, explicit confirm — never automatic, never bulk** |
| Environment Maker | `roles/discoveryengine.agentspaceEditor` | Project | Bulk-reviewable recommendation, customer opts in |
| Basic User | `roles/discoveryengine.agentspaceUser` | Engine (preferred) | Automatic — identical to §3 layer 2, no separate work |

**The hard rule, already encoded and not up for negotiation:**
`identityMap.ts:243` — *"Gemini has NO per-agent co-admin. Grant console edit only if the
customer explicitly wants it; NEVER auto-grant `roles/discoveryengine.editor` on the whole
GCP project (least-privilege)."* Any permission-mapping logic — ours or anyone else's
"definitive blueprint" — that auto-promotes a source bot-editor to a project-wide role
without a human confirming it is not an optimization, it's a privilege-escalation bug.
One bot co-owner does not imply "should edit every agent in the project."

Also note: `roles/discoveryengine.editor` (bare, no `agentspace` prefix) is a **different,
broader** role than `agentspaceEditor` — it governs generic Discovery Engine resources
(data stores, schemas) per `ADK-FILE-GROUNDING-PERMISSIONS.md:11`, not agent editing
specifically. Do not conflate the two when writing the grant logic; `agentspaceEditor` is
the one actually confirmed for agent-building access.

---

## 5. End-to-end flow (EXTRACT → RESOLVE → APPLY → REPORT)

```
EXTRACT  (services/dataverse.ts, opt-in for environment roles)
  bot-level:  readAgentPermissions() → AgentIR.permissions
                { owner, sharedPrincipals[] (roleHint: editor/agent-viewer/end-user),
                  chatAccess }
  env-level:  systemuserroles read (NEW, opt-in — bigger privilege ask than anything
                else this tool reads) → EnvironmentIR { roleAssignments[] }

RESOLVE  (services/identityMap.ts — shared 3-tier logic, one cache for both flows)
  override → email-match → unmatched, result cached in ResolvedPrincipalCache
  (persisted once per engagement, not once per agent — a person shared across many
  agents is only resolved once)

APPLY    (orchestrator.ts Phase 2 — SHIPPED except the environment-role UI, see §6)

  Agent-level:
    if chatAccess org-wide:        shareAgent(ALL_USERS)                    [shipped]
    else:                          ensureAgentAccess(license→engine→agent) [shipped]
    if editor/agent-viewer roleHint present:
                                    FidelityNote('sharing', 'needs-review')  [shipped]
                                    — never auto-promote to a project role

  Environment-level (NEW — see §6):
    Admin  → recommend, one-at-a-time explicit confirm
    Maker  → recommend, bulk-reviewable confirm
    User   → automatic (already covered by the agent-level engine-role check)

REPORT   (report.ts — extend with 3-bucket breakdown)
  Per agent:  auto-applied | manual handoff (named reason + exact console steps) |
              out of scope (no destination equivalent — always named, never hidden)
```

---

## 6. What's actually left to build

Everything in §3 (the destination access chain) is done. What remains is smaller than
the existing design docs suggest:

1. **Environment-role recommend/confirm surface.** `EnvironmentIR` extraction (opt-in
   Dataverse read), `ResolvedPrincipalCache` reuse, a report section + a `SelectMap`
   panel showing proposed Admin/Maker grants for explicit approval. This is genuinely new
   UI + one new opt-in read — the only piece of this whole system that isn't already
   sitting in shipped code.
2. **Two diagnostic spikes, not implementation work:**
   - Does Copilot's Analytics/Evaluation sharing leave any row-share signal at all
     (§2's open item)?
   - Do `roles/discoveryengine.agentViewer` / `agentEditor` exist as valid per-agent
     `setIamPolicy` values? (This session's WebFetch against Google's IAM reference found
     no evidence of them, but truncated before the relevant section — inconclusive, not a
     disproof. Every other independent signal — `grantAgentAccess`'s own live-probed
     history, both design docs — says only `agentUser` exists. Settle it with a
     `_diag_*.ts` spike calling `setIamPolicy` with those two strings against a real test
     agent and reading the literal error, the same way `grantAgentAccess` itself was
     built.)
3. **Doc correction.** Update `permission-mapping.md` §3.2 to stop calling the license/
   engine-role chain unbuilt (§3 above).

**Complexity check:** item 1 touches `dataverse.ts`, a new repo (`environmentAccessSnapshots`),
`identityMap.ts` (reuse, not new logic), `report.ts`, and a new `SelectMap` panel — five
files, no new service layer. Under this project's own 8-file/2-new-service threshold for a
scope flag. No reduction needed; it's already right-sized. The two spikes are throwaway
`_diag_*.ts` scripts per this repo's own convention — they don't ship, don't count against
scope, and must run before item 1's UI ships anything based on the §2 assumption.

---

## 7. Non-negotiable rules (all already encoded somewhere in the codebase — restated here as the single list)

1. Never auto-grant `roles/discoveryengine.editor` or `agentspaceEditor` at the project
   level to compensate for a missing per-agent editor tier. Recommend, get explicit
   confirmation, then grant. (`identityMap.ts:243`)
2. Never treat a per-agent `agentUser` grant succeeding as proof of access without the
   license + engine-role layers underneath it — `ensureAgentAccess()` already does this
   correctly; any new call site must go through it, not `grantAgentAccess()` directly.
3. Collaborative-authoring and Analytics/Evaluation access always surface as
   `needs-review` with the exact source principal named — never silently dropped, never
   silently "solved" by a broader grant. (`permission-mapping.md:903`)
4. ADK/gallery-visible agents cannot have sharing narrowed after registration — a
   restricted source bot promoted to ADK for gallery visibility is always a manual
   handoff, reported as such, not accepted as "shared."
5. A source principal with no resolvable Google identity blocks that principal's grant
   with a named reason in the report — never omitted, never failed silently.

---

*Supersedes the "fully unbuilt" framing in `permission-mapping.md` §3.2 (see §3 above).
Companion docs: `permission-mapping.md` (investigation history and citations),
`environment-and-agent-permission-mapping-plan.md` (environment-role build plan, still
accurate for §6 item 1), `GEMINI-CHATBOT-CLAIMS-FACTCHECK.md` (the live-tested ground
truth this whole document is built on).*
