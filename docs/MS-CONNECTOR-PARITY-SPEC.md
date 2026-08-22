# Spec — Microsoft Connector Parity

**Goal:** any Copilot Studio agent using a Microsoft connector migrates to Gemini and
its tools make the same API calls the source agent made — provably, not presumably.

Status: **draft**. Owner: TBD. Estimate: **4 weeks to a provable baseline.** The week
count for the full connector catalog is deliberately not stated — it is gated on two
measurements in Week 1 (see section 4).

---

## 1. Why this is scoped to Microsoft first

Copilot Studio is a Microsoft product. Every agent we migrate is authored in a
Microsoft tenant, so MS connectors are the ones that appear in *every* customer, not
the ones that appear in some. Atlassian and HubSpot are already bound and proven live
(Jira: 92 projects / 20 issues; HubSpot: 5 companies, 2026-08-16). Microsoft is the
gap that blocks a clean customer promise.

## 2. Current state — measured, not assumed

Source of truth: `server/src/connectors/operationBinding.ts:129` (`VENDOR_BINDINGS`)
and the captured swagger fixtures in `server/src/connectors/fixtures/`.

| Connector | Ops captured | pathStyle | Works today |
|---|---|---|---|
| `shared_commondataserviceforapps` | 93 | `vendor-path` | yes |
| `shared_powerplatformadminv2` | 189 | `vendor-path` | yes |
| `shared_teams` | 170 | `vendor-path` | yes |
| `shared_dynamicscrmonline` | (no fixture) | `vendor-path` | yes, uncaptured |
| `shared_office365` | 143 | `proxy-only` | **no** |
| `shared_sharepointonline` | 141 | `proxy-only` | **no** |
| `shared_onedrive` | 56 | `proxy-only` | **no** |

**452 bindable · 340 blocked.**

`proxy-only` is not a failure state we introduced by accident — it is an explicit,
reasoned verdict recorded per connector in `proxyReason`. The three blocked connectors
share one root cause: their Power Platform swagger describes a **dataset abstraction**
(`/datasets/default/files/{id}`, `/$metadata.json/datasets/...`), not the vendor API.
SharePoint additionally exposes `HttpRequest`, a tunnel that carries the real request
in its body — the swagger describes the envelope, not the call.

**Correction (2026-08-18):** `HttpRequest` is not an open technical gap. `orchestrator.ts:2230`
already refuses it *deliberately* and ships `sharepoint_list_files` / `sharepoint_read_file`
scoped to the folder the source agent named, with a `partial` FidelityNote. Copilot's
`HttpRequest` can call any SharePoint REST endpoint; our app credential carries
`Sites.Read.All` and there is no per-site application permission, so faithful reproduction
would grant every user of the migrated agent read access to every site in the tenant.
That narrowing is the ceiling, not a bug to fix.

**The denominator is wrong.** These 12 connectors are the ones customers happened to use.
Copilot Studio exposes 1,400+ connectors; the Microsoft-published subset and its
pass-through/proxy ratio are **unmeasured**.

**MEASURED 2026-08-19 — and it resizes this whole spec.** `_diag_ms_op_usage.ts` over 131
staged agents across 2 environments found **14** Microsoft connector tool references, and a
blocked work queue of exactly **one operation**: `sharepointonline GetAllTables`, used by one
agent. `teams CreateChat` (12 references, 3 agents) already binds.

Real demand is **0.3%** of the 340-operation surface this spec was sized against. That one
operation was mapped the same day as `sharepoint_list_lists` (ledger §1.42), so the Week 3
mapping backlog is currently **empty**.

This does not retire the spec — it re-points it:
- The 340 number is theoretical demand. Never size mapping work from a swagger surface again;
  run the spike per customer and map what that customer calls.
- Sample is 2 dev tenants. An Outlook- or OneDrive-heavy customer produces a different queue.
- The spike reads `agentTools`, which §1.41 proved has blind spots. It may UNDERCOUNT.
- "Binds" is not "works": no live probe has ever called `teams CreateChat`. Section 6 is now
  the critical path, not the mapping.

## 3. Scope

### In scope
- PP-path to Microsoft Graph mappings for `shared_office365`, `shared_onedrive`,
  `shared_sharepointonline`, covering the operations real agents actually invoke.
- Verification that closes the evidence gap in `verify.ts` (see section 6).
- Readiness reporting that names each blocked operation before a run starts.

### Out of scope
- All 792 swagger operations. We map observed usage, not surface area.
- SharePoint *content* as knowledge — already solved via copy mode into a document
  data store (Gemini's native SharePoint connector returns zero content, confirmed
  2026-08-06). This spec covers SharePoint as a **tool**, not as knowledge.
- Non-Microsoft connectors.
- Flows/workflows (Phase 2 of the product).

## 4. Approach

**Principle: code extracts facts, LLM finds what code missed, tests lock both, runtime
has no LLM.** Every LLM output below is either a report a human reads, or build-time
config that lands in git, passes a Zod schema, and is locked by a test. No LLM decides
anything at migration runtime — that is `call_external_api`, which `boundToolSpec.ts:11`
calls "the weakest possible reproduction."

Mappings follow the proven per-connector pattern, not a new abstraction. `sharepoint.py`,
`jira.py`, `confluence.py` in `server/scripts/connector_tools/` are ~110-190 lines each
and are dispatched from `adk_deploy.py:290`. Each new mapping is another module behind
the same dispatch, with `generic_rest.py` remaining the fallback.

### Week 1 — Measure. Nothing gets built on a guess.

| Task | Days |
|---|---|
| Land raw Copilot payloads (`rawAgents`, opt-in per run, 7-day retention — see connector-transform-plan.md D1) | 1 |
| LLM extractor + parser diff (see below) | 2 |
| Catalog spike — enumerate every connector via the Power Apps API, classify pass-through vs proxy, rank by usage | 0.5 |
| Decision: identity model (section 6a) | — |

**The LLM extractor + parser diff.** Our #1 measured bug class is parsers written
against one tenant's payload shape. Ledger 1.23: a topic-embedded `InvokeConnectorAction`
was not the shape the TaskDialog parser expected, so five Dataverse agents bound **zero**
operations — 45 to 71 once fixed, +58% from a blind spot found by hand, after the fact.
`customConnectorInventory.ts` exists for the same class of failure.

An LLM reading a payload identifies connectors and tools from **intent** (Copilot tool
descriptions are carried verbatim — see `generic_rest.py:22`), so it generalises across
shapes no parser was written for. It must not replace the parser: binding requires
`connectorId` + `operationId` byte-exact against the swagger, and a model that reads
intent perfectly may still emit `PerformUnboundAction` for
`PerformUnboundActionWithOrganization`. Non-deterministic extraction also destroys the
reproducibility that made 1.23 findable at all.

So run both and diff:

```
payload -> parser -> tools[]   (exact ids, deterministic)
payload -> LLM    -> tools[]   (intent-based, shape-agnostic)
                      |
                   diff
   parser-only -> LLM missed it (prompt bug)
   LLM-only    -> PARSER BLIND SPOT   <- 1.23, found automatically
   both        -> confident
```

The LLM supplies a **lead**, never an identifier we bind on. A human confirms; the parser
gets fixed deterministically, with a test.

**Gate:** run it against the five 1.23 agents, where the answer is known to be 26 missing
operations. If the LLM finds them independently, extend the approach. If not, we learn it
in two days rather than two months.

### Week 2 — Make "it works" provable. Before the mapping work, not after.

| Task | Days |
|---|---|
| `verify.ts` honesty fix — assert tool inventory, add `verified: 'unknown'` third state (section 6) | 2 |
| LLM-generated per-agent probe questions | 2 |

A useful probe is a question the agent cannot answer unless the tool actually fired, and
that question differs per agent. The LLM writes the question; **deterministic code decides
pass/fail** on the presence of a `function_response` / grounding chunk. A bad question
fails closed to `verified: 'unknown'`, never to a false pass.

Every connector shipped in Week 3 is only as trustworthy as the thing checking it. Today
`verify.ts` passes on silence.

### Week 3 — Mapping, largest-first.

| Task | Days |
|---|---|
| ~~`shared_onedrive` (56 ops)~~ — **no measured demand**; do not map speculatively | 0 |
| ~~`shared_office365` (143 ops)~~ — **no measured demand** | 0 |
| Map whatever the per-customer usage spike surfaces, largest-first | as found |

**Status 2026-08-19: this week's queue is empty.** The single operation in demand
(`GetAllTables`) shipped. Re-run `_diag_ms_op_usage.ts` against each new customer and map
what it returns — mapping OneDrive's 56 operations today would be building for nobody.

OneDrive is the trial for LLM-assisted mapping: PP swagger and Graph docs are both fully
documented, so this is API-to-API translation with a checkable result. 80%+ bind-and-probe
rate means this is the method for the whole catalog and the tail gets cheap. 40% means we
hand-write the top 10 by usage and report the rest honestly. Either answer is worth a day.

### Week 4 — Prove it and say it.

- Live end-to-end per connector, real content assertions, ledger entries (AC3, AC4)
- Per-operation permission derivation — stop requesting `Chat.ReadWrite.All` for an agent
  that only reads team names (AC8)
- Customer-facing readiness report (AC5)

### After Week 4

The catalog ranking and the measured LLM hit rate together give the real week count for
the remaining tail. **That is when a number for "all MS connectors" gets quoted — not
before.** Any figure stated ahead of those two measurements is invented.

## 5. Acceptance criteria

A connector is DONE when every item below holds. Partial completion is reported as
partial — a connector is never marked supported on the strength of a deploy succeeding.

**AC1 — Binding.** `VENDOR_BINDINGS[<id>].pathStyle` is `vendor-path`, and
`connectorReadiness()` returns `ready: true` for the in-scope operation set. Any
operation still unmappable stays in `blocked[]` with a specific `reason` — never
silently dropped, never optimistically marked bindable.

**AC2 — Unit tests.** `operationBinding.test.ts` covers each newly bound connector:
one test per operation shape asserting method, resolved `urlTemplate`, parameter list
(`in` + `required` + `type`), and `contextRequired`. Vitest, co-located, passing.

**AC3 — Live call.** A `_diag_probe_*` spike calls each mapped operation against a real
tenant and prints the actual response. HTTP 200 alone is not acceptance — the assertion
is on returned *content* (a named mailbox message, a named file, a named list item).
Recorded in `docs/verification-ledger.md` with the date and tenant.

**AC4 — Agent-level proof.** A migrated agent carrying the connector answers a question
that is unanswerable without a real tool call, and the response carries a
`function_response` / grounding chunk proving the tool fired. This is the criterion that
separates "the model improvised a plausible answer" from "the connector works."

**AC5 — Pre-run honesty.** Before a migration starts, the UI and report list every
in-scope operation as will-work or will-not-work, with a reason per failure. A customer
learns what will break **before** the run, not from a support ticket after it.

**AC6 — Fidelity notes.** Every degraded or unmapped operation emits a `FidelityNote`
(`lost` / `needs-review`). Zero silent drops. Project invariant: *a best-effort call
that degrades output MUST record a FidelityNote.*

**AC7 — Idempotency.** Running the migration twice against the same scope produces no
duplicate agents, tools, or `agentFiles`.

**AC8 — Least privilege.** Each connector requests only the Graph scopes its mapped
operations need. Scopes are documented per connector. DWD matches scope strings
**exactly, not hierarchically** (`drive` is not `drive.readonly`) — a near-miss silently
fails at runtime, so scope strings are asserted in a test, not eyeballed.

## 6. Blocking dependency — verification is currently unfalsifiable

`server/src/services/verify.ts` records `verified: true` on three paths that carry no
evidence:

```
{ verified: true, note: 'deployed (assist probe unavailable: 404)' }
{ verified: true, note: 'deployed (assist probe errored)' }
{ verified: true, note: 'deployed and responded' }
```

It also never inspects the deployed agent's **tool inventory** — an agent can deploy
with zero working tools and verify clean.

Until the Week 2 verification work lands, AC3 and AC4 cannot be evaluated, and "works without any error" is
not a claim this system can support. Required changes:

1. Assert the deployed agent's tool list matches the mapped operation set.
2. Stop returning `verified: true` when the probe was unavailable or errored — that is
   `verified: 'unknown'`, a third state, not a pass.
3. For any agent carrying a connector, require tool-call evidence in the probe response.

Standing project rule this enforces: **a 200 is not an answer. `deployed=true` is not
`works=true`.**

## 6a. The one open decision — MS identity model

Source connections run `connectionProperties.mode: Invoker` — per-user delegated auth.
Each Copilot user hit Graph as **themselves**. Our `ms_graph` credential is a single
App Registration with **application** permissions: one identity for the whole tenant.

Two consequences:

1. **Functional.** `/me/messages`, `/me/drive`, `/me/events` have no meaning app-only —
   there is no signed-in user. Every one becomes `/users/{id}/...`, which needs a user id.
2. **Security.** Under Invoker the agent saw what that one user could see. An app with
   `Mail.Read` **application** permission reads every mailbox in the tenant. Migrating a
   personal-scope agent onto app-only can silently widen its reach from one inbox to the
   whole company.

**Option A (recommended) — per-agent impersonation.** Reuse `db/repos/agentConnectorIdentity.ts`,
built for exactly this on the Google side: it stores `impersonateEmail` with
`status: 'confirmed' | 'suggested' | 'needs-review'` and never self-promotes to `confirmed`,
because a Microsoft-side hint is a Microsoft identity, not proof. Preserves source
permissions. +2-3 days. There is currently no Microsoft equivalent —
`services/driveIdentityResolution.ts` is the only consumer.

**Option B — app-only.** Faster, but requires a loud `FidelityNote` naming the widened
scope on every affected agent, and a customer conversation.

**AC9 — No silent widening.** Migrating a per-user (`Invoker`) connector onto an app-only
credential MUST emit a `FidelityNote` naming the scope increase. Silent widening is the
failure mode this AC exists to prevent.

**AC10 — LLM outputs are validated, reviewed and locked.** Any LLM output that reaches
code is (a) produced via structured output against a fixed schema, (b) parsed with Zod and
rejected on mismatch, (c) committed to git and reviewed as a diff, (d) locked by a test if
it drives behaviour, and (e) fails closed to `needs-review` on low confidence. LLM output
is never consumed at migration runtime.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Graph permission surprises; DWD scope matching is exact | Week 1 enumerates required scopes up front; AC8 asserts them in a test |
| Teams chat is a Microsoft-gated protected API | Out of our control; the other 170 Teams ops are unaffected. Named to the customer, never worked around |
| Observed usage is wider than expected | Week 1 produces the real number; scope is re-cut against it, not absorbed silently |
| LLM mapping hit rate too low to scale | Measured on OneDrive in Week 3 before any commitment; fallback is hand-writing the top 10 by usage |
| Parser blind spots cap every downstream number | The Week 1 LLM/parser diff surfaces them; gated on reproducing the known 1.23 result |
| Discovery Engine write quota during live testing | Low insert concurrency + existing backoff; stage test runs |
| Per-user (`Invoker`) auth is the norm in source tenants | Gemini `authorizations` exists and is unused — evaluate in Phase 0, may become its own spec |

## 8. Definition of done

All four remaining MS connectors report `ready: true` for their observed operation set;
AC1 through AC10 hold for each; the verification ledger carries a dated live-tenant entry
per connector; and the pre-run report tells a customer exactly which of their operations
will and will not survive migration.
