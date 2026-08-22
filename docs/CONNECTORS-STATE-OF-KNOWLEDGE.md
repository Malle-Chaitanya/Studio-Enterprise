# Connectors — State of Knowledge

**Date:** 2026-08-19 · **Branch:** `business-ui`

What we actually know about connector migration, separated from what we assume. Every
claim below carries an evidence grade. Where the honest answer is "not measured", it says
so rather than filling the gap with a plausible number.

Built by reading the code and the verification ledger, not from memory.

## How to read this

| Grade | Meaning |
|---|---|
| **P** | Proven live — a real call was made against a real system and the output recorded |
| **M** | Measured — counted from real data (staged agents, captured swagger), no live call |
| **C** | Code-verified — the code says so and was read to confirm it, but never executed against a live system |
| **U** | Unknown / unproven — stated because leaving it out would imply we know |

The distinction that matters most: **`bindable` is not `works`.** A connector can bind
mechanically, deploy cleanly, register `ENABLED`, return HTTP 200 — and still never have
had a single successful call made through it. Several rows below are exactly that.

---

## 1. "Connector" means two different things

Conflating these has caused real confusion, so they are separated everywhere in this doc.

| | **Knowledge connector** | **Tool connector** |
|---|---|---|
| What it does | Indexes content so the agent can search it | Makes a live API call at question time |
| Migrates as | Discovery Engine data store / native connector | ADK Python tool baked into the Reasoning Engine |
| Example | SharePoint site indexed as documents | `jira_search` calling Atlassian at runtime |
| Fails as | Missing/stale documents | Tool error at runtime, or no tool at all |

SharePoint appears in **both** columns, which is the main source of confusion: its content
migrates as knowledge, while `GetAllTables` migrates as a tool. Both are true at once.

---

## 2. The binding registry — what the code actually holds

Source: `server/src/connectors/operationBinding.ts` (`VENDOR_BINDINGS`). **13 connectors**
registered. Swagger fixtures captured for **12** (`server/src/connectors/fixtures/`).

`bindOperation()` returns one of five statuses: `bindable`, `custom-tool`, `proxy-only`,
`unknown-connector`, `unknown-operation`. A connector absent from the table returns
`unknown-connector` rather than a guessed base URL — a wrong host produces a tool that
fails confusingly at runtime, which is worse than a clear refusal.

### `vendor-path` — 9 connectors (bind mechanically, no hand-written mapping)

| Connector | Base URL | Auth | Live-proven? |
|---|---|---|---|
| `shared_jira` | `api.atlassian.com/ex/jira/{cloudId}/rest/api` | atlassian-basic | **P** — see §4 |
| `shared_confluence` | `api.atlassian.com` | atlassian-basic | **P** — see §4 |
| `shared_hubspotcrm` | `api.hubapi.com` | bearer-token | **P** — see §4 |
| `shared_hubspotcrmv2` | `api.hubapi.com` | bearer-token | **U** |
| `shared_hubspotsettingsv2` | `api.hubapi.com` | bearer-token | **U** |
| `shared_commondataserviceforapps` | `{dataverseOrgUrl}` | aad-token | **U** |
| `shared_dynamicscrmonline` | `{dataverseOrgUrl}` | aad-token | **U** (no fixture) |
| `shared_powerplatformadminv2` | `api.powerplatform.com` | aad-token | **U** |
| `shared_teams` | `graph.microsoft.com` | aad-token | **U** — see §5 |

### `proxy-only` — 4 connectors (cannot bind from swagger)

| Connector | Ops in swagger | Why refused (verbatim from `proxyReason`) |
|---|---|---|
| `shared_office365` | 143 | Paths are a Power Platform table abstraction (`/$metadata.json/datasets/...`), not Graph paths |
| `shared_sharepointonline` | 141 | Operations are dataset abstractions; `HttpRequest` is a tunnel carrying the real request in its body — the swagger describes the tunnel, not the call |
| `shared_onedrive` | 56 | Paths (`/datasets/default/files/{id}`) are an abstraction over Graph, not Graph paths |
| `shared_googledrive` | — | Paths are a Power Platform abstraction, not Drive API paths |

**452 bindable · 340 blocked** across the captured Microsoft swagger. **M**

`proxy-only` is a reasoned, recorded verdict per connector — not an accident or a TODO.
The three Microsoft ones share one root cause: their swagger describes a dataset
abstraction, not the vendor API.

### Per-operation rescue

`VendorBinding.customToolOperations` lets one operation on a `proxy-only` connector be
reproduced by a hand-written tool and reported as ready. `proxy-only` is a per-CONNECTOR
verdict, but its reasons are per-OPERATION — without this, an operation we genuinely
reproduce was still reported to the customer as "will not be recreated", understating what
migrated. That fails the honesty rule the same way overstating does.

Currently **one** entry: `sharepointonline GetAllTables` → `sharepoint_list_lists`.

`HttpRequest` deliberately stays refused, and a test asserts one custom tool does not
rescue the rest of the connector.

---

## 3. Real demand is 0.3% of the swagger surface — measured

The 340-operation figure sizes what the connectors **expose**. It is not what anyone calls.

`_diag_ms_op_usage.ts` over **131 staged agents, 2 environments**: **M**

```
Microsoft connector tool references: 14

BLOCKED (needs a hand-written mapping)
    2×  sharepointonline   GetAllTables    Confluence Knowledge Assistant

ALREADY BINDS
   12×  teams              CreateChat      AA, A, knowledge Nexus

WORK QUEUE: 1 distinct operation in demand, against a swagger surface of 340.
```

Mapping in swagger order would have spent weeks before reaching the only operation a
customer actually needed. `GetAllTables` shipped the same day it was measured.

**Three caveats that bound this conclusion — all of them material:**

1. **2 dev tenants, not an enterprise sample.** A customer heavy on Outlook or OneDrive
   produces a different queue. Re-run per customer; that is what the spike is for.
2. **It reads `agentTools`, which has a known blind spot** (§6). If connector actions hide
   the same way AI Builder actions do, this number **undercounts**.
3. **`teams CreateChat` "already binds" per the table — binding is not proof it works.**
   No live probe has ever called it. See §5.

---

## 4. What is actually proven live

The only connector tools ever confirmed to make a real successful call, from a **deployed**
agent (`_diag_probe_connectors.ts`, ledger §1.39): **P**

```
JIRA      jira_list_projects  → 92 projects
          jira_search         → 20 recent issues
HUBSPOT   get_companies       → 5 companies
DRIVE     auth failed (google-service-account): unauthorized_client —
          "client not authorized for any of the scopes requested"
```

Confluence has a separate live capture: 5 ops, 2406ms, and a live `Confluence_agent`
engine that answers Confluence questions. **P**

**Everything not in this list is unproven at runtime**, including every Microsoft
connector.

### Google Drive is broken on deployed agents

Auth fails with `unauthorized_client` on the **deployed** agent while the same credential
works locally. Root-caused in ledger §1.39 as a stale pickle, not a missing grant. 12 Drive
tools exist in code and none of them are reachable in that state. **P**

---

## 5. Teams — bound but never called

`shared_teams` maps to Graph paths verbatim, so it binds mechanically and shows as ready.
It is also the **highest-demand Microsoft operation we have** (12 of 14 references).

No live call has ever been made through it. **U**

There is also a known auth-shape problem, separate from binding:

- Copilot's `Invoker` mode means per-user delegated auth in the source. **C**
- Our `ms_graph` credential is **app-only** — one identity, tenant-wide. **C**
- Teams chat APIs (`Chat.Read.All` / `Chat.ReadWrite.All`) are Microsoft **protected
  APIs** requiring an approval request form for app-only access. **C**

So `CreateChat` binding cleanly does not mean a migrated agent can create a chat. Whether
it can is **U** — it needs a live probe, and possibly a Microsoft approval, neither of
which has happened.

This is the single most valuable unknown in this document: it is the most-used MS
operation and its status is assumed rather than known.

---

## 6. The parser has a proven blind spot

`services/blindSpot.ts` has an LLM read the same raw Copilot payload the parser reads,
identify tools by intent, and `diffTools()` reports what only one reader saw.

**Sweep: 12 agents, `org32322095`** — 38 tools confirmed by both, 3 parser-only, 5 leads. **M**

**Confirmed finding:** `InvokeAIBuilderModelAction` inside a topic never becomes an
`agentTools` entry. An agent whose only outward call is an AI Builder model reports
**0 tools**. Verified against the raw payload on "D365 Sales - Data Enrichment". **P**

Precisely scoped — this is *not* a silent loss: `dataverse.ts:734` sets a topic-level
`usesAiBuilder` flag and `assess.ts:222` reports it. But it never reaches `agentTools`,
and `agentTools` drives tool migration and the connector readiness counts.

**The LLM supplies leads, never identifiers.** In this same run it reported
`InvokeAIBuilderModelTaskAction` (real kind: `InvokeAIBuilderModelAction`) and elsewhere
returned a node id where a model id belonged. It read intent correctly every time and got
the identifier wrong repeatedly. Binding on that output would have bound nothing, or the
wrong thing.

Design rule this settled: **code extracts facts, LLM finds what code missed, tests lock
both, runtime has no LLM.**

---

## 7. How tools are actually built (the hardcoding question)

`scripts/adk_deploy.py` dispatches on connector kind: **C**

```python
if kind in ("sharepointonline", "sharepoint", "onedrive"): → connector_tools/sharepoint.py
if kind == "googledrive":                                  → connector_tools/google_drive.py
if kind == "jira":                                         → connector_tools/jira.py
if kind == "confluence":                                   → connector_tools/confluence.py
otherwise:                                                 → connector_tools/generic_rest.py
```

| Module | Tools | Notes |
|---|---|---|
| `google_drive.py` | 12 | list/read/metadata/find-by-path/search/copy/create/create-folder/create-by-path/update/delete/extract-archive |
| `sharepoint.py` | 3 | `list_files`, `read_file`, `list_lists` |
| `jira.py` | 3 | `search`, `get_issue`, `list_projects` |
| `confluence.py` | 1 | `live_search` |
| `generic_rest.py` | n | per-operation bound tools from captured swagger, else one `call_external_api` |

**What is generic and what is not** — stated plainly because it has been asked twice:

- Extraction and mapping: **fully generic**, no agent-specific code anywhere. **C**
- Binding: **table-driven** via `VENDOR_BINDINGS` (13 connectors). **C**
- Python tools: **hardcoded per kind** for 4 connectors via the `if kind ==` dispatch. **C**
- `generic_rest.py` already **is** the unified engine — it builds per-operation tools from
  captured swagger for anything not in the four special cases. **C**

So "hardcoded" is accurate for 4 connectors and wrong for the rest. The unification path is
to replace the `if kind ==` dispatch with a capability registry and move the vendor-specific
transforms into declarative entries. Not started.

---

## 8. A constraint that governs everything above

**Deployed tool behaviour is frozen in the Reasoning Engine pickle at deploy time.**

There is no API that lists a deployed agent's tools. A code fix to a connector tool does
**not** reach an already-deployed agent — it must be redeployed. Drift detection cannot
see a fix made on our side, so `orchestrator.ts:1719` returns `alreadyExists: true` and
skips it unless `forceRedeploy` is set. **C**

Two live consequences today:

- The `forceRedeploy` flag is accepted by `routes/migrate.ts:52` but **never sent by the
  web client** (`web/src/api.ts:426`). The repair path is currently unreachable from the
  UI. **C**
- Agents deployed before the `google-adk` pin fix (2026-08-19) carry unpinned requirements
  and fail every query with `TypeError: 'NoneType' object is not subscriptable`. Confirmed
  live on RE `1427317275702067200` ("Migrate Advisor"), which returns **HTTP 200** with
  that error in the stream. **P** — ledger §1.44

The second is why "a 200 is not an answer" is a rule and not a slogan.

---

## 9. Open questions, honestly labelled

| # | Question | Status |
|---|---|---|
| 1 | Does `teams CreateChat` work from a migrated agent? | **U** — highest-value unknown; needs a live probe + possibly MS protected-API approval |
| 2 | Can one app-only credential reach every MS connector? | **U** — not established; Teams chat APIs already known to need separate approval |
| 3 | Does the 1-operation work queue hold on a real enterprise tenant? | **U** — measured on 2 dev tenants only |
| 4 | Do connector actions hide inside topics the way AI Builder actions do? | **U** — the blind-spot diff is the check; not yet run at scale |
| 5 | Should `InvokeAIBuilderModelAction` become an `agentTools` entry? | Open **product** decision — the model itself is not migratable today |
| 6 | Is Google Drive's `unauthorized_client` fixed by redeploy alone? | **U** — diagnosed as a stale pickle; not retested since the pin fix |
| 7 | Which of the 3 remaining `proxy-only` MS connectors have real demand? | **M** — zero, on the tenants measured |

---

## 10. How to re-measure any of this

```bash
cd server

# What MS operations do the staged agents actually reference?
npx tsx src/spikes/_diag_ms_op_usage.ts

# What did the parser miss? (needs OPENAI_API_KEY)
npx tsx src/spikes/_diag_blind_spot.ts "" <envUrl> <limit>

# Confirm a blind-spot lead against the raw payload
npx tsx src/spikes/_dump_component.ts "<agent>" "<component>"

# Do the deployed connector tools actually work?
npx tsx src/spikes/_diag_probe_connectors.ts

# Is a specific deployed engine alive, and why not?
npx tsx src/spikes/_diag_re_traceback.ts <reasoningEngineId>
```

Unit tests covering this area: `operationBinding.test.ts`, `connectorValidator.test.ts`,
`connectorCredentials.test.ts`, `confluenceRouting.test.ts`, `blindSpot.test.ts`.

---

## What this document deliberately does not claim

- That any Microsoft connector works end to end. None has been proven live.
- That the 1-operation work queue generalises beyond the 2 tenants measured.
- That `bindable` implies a working tool. It implies a URL was constructed.
- A week estimate for full connector-catalog parity. It is gated on questions 1–3 above,
  and any number given before those are answered would be invented.
