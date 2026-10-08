# Design: MCP Server Migration (Track C)

Status: **proposed** — not implemented. Architect design, 2026-09-28.
Scope: make `AgentToolIR.kind === 'mcp-server'` produce a real, callable MCP toolset on the
deployed Gemini agent, or an honest `FidelityNote` saying why it could not.

---

## Summary

MCP servers are already extracted losslessly into the IR (`McpBindingIR`) and the Python
deploy side already knows how to build both an Agent Registry toolset and a raw-URL
`McpToolset`. The gap is entirely in the middle: nothing ever supplies the destination-side
facts those builders need (`serverUrl`, `registryServerName`, `authKind`, `secretIds`), so
100% of real bindings arrive at `_build_mcp_toolset` with nothing to connect to.

This design adds a **destination-side MCP server configuration** captured on the Connectors
step (URL + bearer token per distinct server, keyed by `connectorId`), a **destination Agent
Registry lookup** to prefer the registry path where it exists, and an **MCP pre-flight** that
opens a real session and reconciles `tools/list` against the source allow-list before the
agent is deployed.

Stages touched: **create** (orchestrator spec-building + `adk_deploy.py`) and **report**
(fidelity). Plus the pre-migration Connectors configuration screen, which is not a pipeline
stage. **Extract and map are unchanged.**

---

## P0 — two live defects this design sits on top of

These are not part of the feature. They are bugs that must be fixed first, and the first one
is currently breaking agents in production.

### P0-1 `_build_mcp_toolset` aborts the entire deploy for any agent with an MCP binding

`server/src/orchestrator.ts:2897` builds `scopedMcpTools` for every `mcp-server` tool and
passes it whenever the array is non-empty. Every entry has `serverUrl: undefined` (verified
10/10 live). `server/scripts/adk_deploy.py:804` therefore raises:

```python
raise RuntimeError(
    f"mcp tool '{mcp.get('id')}' has neither registryServerName nor serverUrl — nothing to connect to"
)
```

and the caller at `adk_deploy.py:1511-1525` wraps **all** tool wiring in one try/except that
`return`s on the first exception:

```python
for mcp in (spec.get("mcpTools") or []):
    tools.append(_build_mcp_toolset(mcp, args.project))
    ...
except Exception as e:  # noqa: BLE001
    emit({"error": f"tool wiring failed: {e}"}); return
```

So for the 5 filefuze agents that use MCP, the agent loses **not just MCP** but every live
connector tool, every flow tool, every Cloud SQL tool, and the deploy itself. The blast radius
is the whole agent, not the one unsupported tool.

**Fix (ships alone, before anything else):** in the orchestrator, only emit an `mcpTools`
entry that is actually buildable — i.e. has `registryServerName` or `serverUrl`. Everything
filtered out emits a `lost` FidelityNote. This makes today's behaviour honest and unblocks
those agents immediately, with zero new capability.

### P0-2 `tool_filter` is an undefined name on the raw-URL path

`adk_deploy.py:851-854`:

```python
return McpToolset(
    connection_params=StreamableHTTPConnectionParams(url=server_url, headers=headers or None),
    tool_filter=tool_filter,
)
```

`tool_filter` is never assigned anywhere in `_build_mcp_toolset` (grep confirms: the only
other occurrences are the `_mcp_tool_filter_instruction` function name and comments). The
raw-URL path raises `NameError` before it opens a socket. This is independent confirmation
that **the raw-URL path has never executed**, live or otherwise — it cannot have.

The fix is also a fidelity win, and it is the single most important asymmetry in this design:

```python
# 'specific' -> a REAL construction-time filter. 'all' -> None.
tool_filter = mcp.get("tools") or None
```

`McpToolset` accepts `tool_filter`; `AgentRegistry.get_mcp_toolset()` does not. So:

| Path | Honours `toolSelection: 'specific'` by | Strength |
|------|---------------------------------------|----------|
| Raw URL | **construction** (`tool_filter`) | hard guarantee |
| Agent Registry | **instruction** (`_mcp_tool_filter_instruction`) | strong hint only |

This inverts the intuitive preference order and must be recorded (see Decisions).

---

## Architecture

### Where this sits across the phase boundary

```
PHASE 1 EXTRACT   Dataverse -> parseMcpBinding() -> McpBindingIR{operationId, toolSelection,
                  tools[], serverUrl?} -> stagedAgents
                  ── UNCHANGED BY THIS DESIGN ──

(out of band)     Connectors step: operator supplies MCP server URL + token per connectorId
                  -> Secret Manager (token) + connectorCredentials (url + secret ids)

PHASE 2 INSERT    read staged rows
                  -> classifyMcpServer()        (services/mcpServers.ts,  pure)
                  -> listRegistryMcpServers()   (services/mcpRegistry.ts, destination read)
                  -> buildMcpToolSpecs()        (services/mcpServers.ts,  pure)
                  -> preflightMcpServers()      (services/mcpPreflight.ts, live MCP session)
                  -> AdkSpec.mcpTools -> adk_deploy.py -> report
```

The staging DB stays the only handoff. Nothing in Phase 2 reaches back into Dataverse;
nothing in Phase 1 learns about Gemini, the destination registry or the customer's MCP
credentials.

### AgentIR impact: **NO**

`McpBindingIR` is not modified. This is deliberate and load-bearing:

- `McpBindingIR.serverUrl` is a **source-side, best-effort hint** derived from the Copilot
  custom connector's backend host (`connectors/customConnectorInventory.ts:175
  resolveMcpServerUrls`). Its own doc comment already warns it is usually a bare host
  (`api.hubapi.com`), not a callable `/mcp` route.
- The URL the deployed agent connects to is **destination configuration supplied by the
  operator**. Writing it back into the IR would put Phase 2 config inside a Phase 1 artifact,
  break the "extraction produces IR, mapping consumes IR" contract, and make an already-staged
  row's meaning depend on when it was read.

The two values stay separate for their whole lives. The extracted hint is used **only** to
pre-fill the UI's placeholder text ("your tenant's connector points at `api.hubapi.com`") and
never as a value. **Never construct a `/mcp` suffix from the host.**

### DB schema impact: **YES — additive, requires sign-off**

No new collection. `connectorCredentials` is already keyed `{appUserId, connectorId}` unique,
already stores `secretIds: Record<field, secretId>` + `project`, already survives the session
TTL, and is already the authority downstream resolves ids from. An MCP server is a connector
with a credential — it fits without distortion.

One additive optional field on `ConnectorCredentialRecord`
(`server/src/db/repos/connectorCredentials.ts:25`):

```ts
/** For MCP-server connectors: the operator-supplied MCP endpoint. NOT a secret — it is
 *  destination config that must stay readable for pre-flight diffing and the report. */
serverUrl?: string;
```

- Optional ⇒ no migration, every existing record stays valid, older code ignores it.
- It is **not** put in Secret Manager: a URL is not a credential, and burying it there would
  make it unreadable for the pre-flight diff and the fidelity report while adding a secret
  read to every render of the Connectors screen.
- The repo's security invariant ("secret ids and field names only — never a credential
  value") is preserved: a URL is neither.

### How a "distinct server" is keyed: **`connectorId`**

| Candidate | Verdict |
|-----------|---------|
| `connectorId` | **Chosen.** Present on 9/10 live bindings. Stable. Shared correctly: HubSpot's `shared_cr88d-5fcrm-20hubspot-…` is one server used by both DealMate and Meeting Intelligence Agent, so the operator is asked once. It is already the primary key of `connectorCredentials`. It already flows into the Connectors step via `connectorToolBuilder.ts:437 agentConnectorIds()`. |
| `operationId` | Rejected. Per-binding, not per-server — Dataverse's 4 bindings would ask for the same URL four times. |
| `serverUrl` | Rejected. It is the thing we are trying to obtain; it cannot also be the key. |

**Credential-group reuse does not apply and must not be forced.** `connectorCredentialScope()`
falls back to the connector id for anything without a registry `credentialGroup`, which is
correct here and matches the reasoning already written into
`connectorCredentials.ts:138-141` — a token that happens to reach the same vendor as a
first-party connector is still a different credential. A HubSpot MCP token is not the HubSpot
REST connector's token.

**Consequence, stated honestly:** the D365 Contact Center Admin MCP binding has **no connector
id**. It cannot be keyed, therefore cannot be configured, therefore can never be migrated
under this design. It is a permanent `lost` with a note naming exactly that reason.

### Working assumption (must appear in the report, not just here)

> **Microsoft/Power-Platform-hosted MCP servers are a hard limitation.** Copilot reaches them
> through the Power Platform proxy using the signed-in user's Microsoft connection. A
> Google-deployed Reasoning Engine has no such connection and is very unlikely to be able to
> reach the endpoint at all. We do **not** attempt them, do **not** ask the operator for a URL
> we believe cannot work, and report them as `lost` with the reason.

This covers 4 of 5 live servers: Dataverse (`shared_commondataserviceforapps`, 4 bindings),
Outlook Mail (`shared_a365outlookmailmcp`), Outlook Calendar
(`shared_a365outlookcalendarmcp`), D365 Contact Center Admin. **HubSpot CRM MCP is the only
realistic Track C target in the live tenant**, and the only one this design can be tested
against.

This assumption is *disprovable* — if a Microsoft-hosted MCP endpoint turns out to be publicly
reachable with a bearer token, `classifyMcpServer()` is the single place that changes. It is a
classification, not a hardcoded exclusion list scattered through the pipeline.

Note this does **not** regress anything: Dataverse and Outlook already have far better
migration paths in this product (Track B direct-connector rebuild, the Cloud SQL cutover, the
Outlook→Gmail surface substitution). Track C is additive for third-party servers.

### Components

| Component | Layer | New? | Responsibility |
|-----------|-------|------|----------------|
| `services/mcpServers.ts` | service (pure) | **new** | `classifyMcpServer(connectorId)` → `'third-party' \| 'microsoft-hosted' \| 'unidentifiable'`; `mcpServerKey(tool)`; `buildMcpToolSpecs(tools, creds, registry)` → spec entries + notes. No I/O ⇒ unit-testable, per the testing rule. |
| `services/mcpRegistry.ts` | service | **new** | `listRegistryMcpServers(saToken, project, location)` → `'present' \| 'absent' \| 'unreadable'` + entries. Cached per `{appUserId, project}`. |
| `services/mcpPreflight.ts` | service | **new** | Opens a real Streamable HTTP MCP session, calls `tools/list`, diffs against the allow-list. Mirrors `connectorPreflight.ts` in shape and honesty. |
| `db/repos/connectorCredentials.ts` | repo | edit | `serverUrl?: string` on the record + persist it in the upsert. |
| `routes/migrate.ts` | route | edit | `/connector-requirements` describes MCP servers; the save route accepts `serverUrl`. |
| `orchestrator.ts` | orchestrator | edit | Replace the `scopedMcpTools` literal with a `buildMcpToolSpecs()` call; run the pre-flight; extend the existing MCP fidelity block. |
| `services/adkDeployer.ts` | service | edit (doc) | `AdkSpec.mcpTools` doc comment — retire the "honest gap" note, state what is now true. |
| `scripts/adk_deploy.py` | deploy | edit | Fix P0-2; align the secret field name. |
| `web/src/pages/ConnectorConfig.tsx` | web | edit | Render the MCP server card (URL + token). |

---

## The four pieces

### (1) Collecting URL + token on the Connectors step

`agentConnectorIds()` already yields MCP connector ids, so they already reach
`/api/migrate/connector-requirements`. Today they fall into the custom-connector fallback at
`routes/migrate.ts:1174-1201` and are described as a generic "custom connector API token" —
which is nearly right for the token and has nowhere at all to put the URL.

Add an explicit MCP branch **before** that fallback:

```
GET /api/migrate/connector-requirements
  -> { connectorId, name, mcp: true,
       mcpSupport: 'supported' | 'unsupported-host' | 'unidentifiable',
       unsupportedReason?: string,          // shown, not hidden, when not 'supported'
       serverUrl: { supplied: boolean, value?: string, hostHint?: string },
       fields: [ { key: 'api_key', label: 'MCP server token', supplied } ],
       toolSelection, declaredTools }
```

- `mcpSupport !== 'supported'` renders as an explanation, **not** an input. Asking for a
  credential we will not use is worse than saying why.
- `hostHint` is the extracted `McpBindingIR.serverUrl` (e.g. `https://api.hubapi.com`),
  rendered as placeholder/help text **only**. Never prefilled as a value.
- `declaredTools` + `toolSelection` are shown so the operator can see what this server is
  expected to expose before the pre-flight tells them what it actually exposes.

Save path: the existing `POST` credential route is reused unchanged for the token (it already
does tenant-scoped ids, `upsertSecretIfChanged`, per-field merge, labels). It gains one
optional `serverUrl` body field that is validated (`https:` only, no credentials in the URL,
no query string carrying a token) and passed through to `upsertConnectorCredential`.

`validateConnectorCredentials()` returns `unverified` for an unknown connector id, which is
the correct and already-correct behaviour — it must not be made to block.

**Security:** the token lives only in Secret Manager under the existing
`studio-enterprise-{owner}-{scope}-{field}` id; the record holds the id. The URL is logged;
the token never is. Reject a URL with embedded userinfo (`https://user:pass@host`) precisely
because it would then be logged.

### (2) Populating `serverUrl` / `registryServerName` / `authKind` / `secretIds`

`orchestrator.ts:2897` becomes a call into `buildMcpToolSpecs()`. Resolution order per tool:

1. `classifyMcpServer(connectorId)`. Not `'third-party'` ⇒ **no spec entry**, one `lost`
   FidelityNote naming the reason. Stop.
2. Destination registry match (piece 3) ⇒ `registryServerName` + `registryLocation`. No
   `serverUrl`, no `secretIds` (the registry path authenticates as the engine's own service
   account).
3. Else the stored `ConnectorCredentialRecord` for `{appUserId, connectorId}`, filtered to
   `record.project === dest.project` (the same filter `/connector-requirements:1131` already
   applies — a secret in another project is unreadable by the deployed engine):
   - `serverUrl` from the record. Absent ⇒ **no spec entry** + `needs-review` note telling the
     operator exactly which screen fixes it.
   - `authKind: 'bearer'` — the only kind `adk_deploy.py` supports, and the only kind we ask
     for. Anything else would deliberately raise in Python; we must not emit it.
   - `secretIds: { api_key: record.secretIds.api_key }`. Absent ⇒ **no spec entry** +
     `needs-review`.
4. `tools`: `toolSelection === 'specific' ? mcp.tools : undefined`. Unchanged semantics —
   `'all'` emits no list, `'unknown'` is treated as specific-with-empty-list per
   `McpBindingIR`'s own doc, which means nothing to grant ⇒ no spec entry + `needs-review`.

**The invariant enforced here:** an entry is emitted only if `adk_deploy.py` can build it. That
is what retires P0-1 permanently rather than papering over it.

**Field-name alignment.** `adk_deploy.py:842` hardcodes `_secret("token")`; the TypeScript
save path stores `api_key`. Because the raw-URL path has never run (P0-2), there is no
deployed agent depending on `token`. Change Python to read `api_key`, accepting `token` as a
legacy alias, so one name holds end to end. Do **not** silently remap in TypeScript — a
rename that exists only in the emitter is exactly the "one fact, two implementations" bug
class this codebase keeps hitting.

### (3) Resolving `registryServerName` from the destination Agent Registry

**This piece is the least proven and is gated on Researcher confirmation.** There is no Agent
Registry client code in the server today; `agentregistry.googleapis.com` appears only as a
service name in `spikes/_diag_cloudquotas.ts`. The exact REST surface for *listing* registered
MCP servers in a project — method, version, whether it is per-location, whether the SA needs a
role beyond Discovery Engine — is unknown and must be established by a spike before this
ships.

Shape once known:

```ts
listRegistryMcpServers(saToken, project, location = 'global'):
  Promise<{ state: 'present' | 'absent' | 'unreadable';
            servers: Array<{ name: string; displayName?: string; sanctionedTools: string[] }> }>
```

Three states, not two — copied deliberately from
`connectorPreflight.ts:97 hasProjectWideSecretAccess`, whose own comment explains why: "I could
not check" and "it is not there" are different facts and only one of them is about the
customer. `'unreadable'` ⇒ fall through to the raw-URL path **and** emit a `needs-review` note
saying the registry could not be consulted. Never let an unreadable registry be silently
reported as an absent one.

**Matching a source connector to a registry entry.** There is no shared key.
`shared_cr88d-5fcrm-20hubspot-…` has no derivable relationship to any Google registry name.
Therefore:

- **Never fuzzy-match.** A wrong match wires the agent to a *different server* — a silent
  correctness failure far worse than falling back to raw URL.
- Match only on an exact, normalized vendor token where the registry entry's `displayName`
  makes it unambiguous, and **surface every proposed match to the operator for confirmation**,
  reusing the mechanism already built for surface substitutions
  (`agentSurfaceChoice.ts` / the Map-users pattern).
- Default when unconfirmed: **raw URL**. This is the honest default and, per P0-2, the one
  that can actually enforce a `'specific'` allow-list by construction.

`sanctionedTools` is why the registry listing matters even when we do not use the registry
path: it is the destination's own sanctioned list, and `AdkSpec.mcpTools.tools` is documented
as the intersection of that with the source allow-list. Where we have it, intersect. Where we
do not, say so.

### (4) MCP pre-flight — a real session + `tools/list`

New `services/mcpPreflight.ts`, run in Phase 2 immediately after `preflightConnectors`
(`orchestrator.ts:2852-2887`), same placement, same bounded concurrency, same
per-distinct-server dedup so 5 agents sharing HubSpot open one session.

```ts
preflightMcpServers(saToken, project, targets): Promise<McpPreflight[]>
// McpPreflight {
//   connectorId, name,
//   reachable: boolean,
//   blocker?: 'no_server_url' | 'no_credential_recorded' | 'secret_unreadable'
//           | 'session_failed' | 'no_sanctioned_tools',
//   advertised: string[],          // what tools/list returned
//   allowed: string[],             // the intersection we will actually emit
//   missing: string[],             // allow-listed but NOT advertised
//   detail?: string,
// }
```

Secrets are read with the existing `getEntraSecret()` and go straight into the session
headers — never logged, never returned on the result, exactly as
`preflightConnectors:174-180` already does.

**What this proves, and what it does not.** Both limits must be written into the module's own
doc comment or they will be forgotten:

1. **`tools/list` is not proof of callability.** Live-proven 2026-09-01: a server advertised
   `list_engines` and 403'd every call to it. A tool appearing in the list means *advertised*,
   not *callable*. The pre-flight can therefore prove **absence** decisively and **presence**
   only weakly.
2. **Our server is not the deployed agent.** This is the same third-identity problem
   `connectorPreflight.ts` opens with. A session that succeeds from our egress IP with our
   network path does not prove the Reasoning Engine can reach the same endpoint. Reachability
   here is necessary, not sufficient.

**Verdict table — and it never blocks the agent, only the one tool:**

| Situation | Action | Report |
|-----------|--------|--------|
| `'specific'`, all allow-listed tools advertised | emit spec, `tools` = allow-list | `mapped`, noting advertised ≠ proven callable |
| `'specific'`, some missing | emit spec, `tools` = **intersection** | `partial`, **naming every missing tool** |
| `'specific'`, all missing | **no spec entry** | `lost` — a server exposing none of the sanctioned tools grants only an invitation to call something outside the allow-list |
| `'all'` | emit spec, `tools` **stays undefined** | `mapped`; the advertised list is recorded as information only |
| `'unknown'` | no spec entry | `needs-review` — nothing to grant |
| session fails / unreachable / 401 | **no spec entry** | `needs-review` with the blocker and the fix |

**Why the tool is dropped rather than deployed-and-broken** — and why this differs from
`preflightConnectors`, which deliberately deploys a failing connector: a broken *connector*
tool degrades one capability. A broken *MCP* entry raises inside `_build_mcp_toolset` and
`adk_deploy.py:1524` aborts **all** tool wiring and returns. Dropping one unreachable MCP
entry saves the entire agent. This asymmetry is the whole justification and belongs in the
code comment.

**Why `'all'` is never narrowed to the advertised list** (hard constraint): narrowing would
freeze a dynamic server's surface at migration time. A server that gains a tool next week
would be silently forbidden it, and the report would have claimed a faithful `'all'`
migration. Intersecting is only ever applied to an allow-list that already exists.

**Why `'specific'` is never widened**: the emitted `tools` is always a subset of
`mcp.tools`. With P0-2 fixed the raw-URL path enforces it by construction; the registry path
enforces it by instruction and the report must say which of the two applied. A hint is not a
guarantee and the customer is entitled to know which they got.

---

## Implementation Sequence

Each step is independently shippable and independently valuable.

**S0 — stop the bleeding (no new capability).** *One PR. Ship immediately, ahead of the rest.*
1. `orchestrator.ts:2897` — filter `scopedMcpTools` to entries that have
   `registryServerName || serverUrl`. With today's data that is zero entries, so `mcpTools`
   goes `undefined` and the 5 MCP agents deploy again with all their other tools intact.
2. Every filtered-out tool emits a `lost` FidelityNote (extend the existing block at
   `orchestrator.ts:3220`, do not add a second reporting site).
3. `adk_deploy.py:853` — define `tool_filter = mcp.get("tools") or None`.
4. Unit test in `mcpServers.test.ts` for the filter predicate; `npm run typecheck` both sides.
   *Verify by re-running a migration of DealMate and confirming its connector tools deploy.*

**S1 — capture the configuration.** *Depends on S0.*
5. `db/repos/connectorCredentials.ts` — add `serverUrl?: string`, persist in the upsert.
6. `services/mcpServers.ts` — `classifyMcpServer`, `mcpServerKey`. Pure. Unit-tested against
   all 5 live connector ids.
7. `routes/migrate.ts` — MCP branch in `/connector-requirements`; accept + validate
   `serverUrl` on the save route.
8. `web/src/pages/ConnectorConfig.tsx` — MCP server card; unsupported hosts render as an
   explanation, never an input.
   *Shippable alone: the operator can configure HubSpot MCP and nothing downstream changes.*

**S2 — wire it into the spec.** *Depends on S1.*
9. `services/mcpServers.ts` — `buildMcpToolSpecs(tools, creds, registry?)`, pure, returns
   `{ specs, notes }`. Unit-tested for every branch in the verdict table.
10. `orchestrator.ts` — replace the inline literal with the call.
11. `adk_deploy.py` — `_secret("api_key")` with `token` as legacy alias.
12. `services/adkDeployer.ts:196-233` — rewrite the `AdkSpec.mcpTools` doc comment to state
    what is now true. Gaps 1 and 2 change; gaps 3 and 4 remain open and must stay written down.
    *First point at which a raw-URL MCP toolset could deploy. Expect to discover the real
    HubSpot `/mcp` route here.*

**S3 — pre-flight.** *Depends on S2.*
13. `services/mcpPreflight.ts` + tests (mock the transport; never hit a live server in a unit
    test).
14. `orchestrator.ts` — run it after `preflightConnectors`; feed results back into
    `buildMcpToolSpecs`; extend the fidelity block.
15. `spikes/_test_mcp_preflight.ts` — live probe against HubSpot MCP.

**S4 — registry path.** *Depends on Researcher; can trail S3 indefinitely.*
16. Spike the Agent Registry list API. **Do not write `mcpRegistry.ts` until the spike returns
    a real response shape.**
17. `services/mcpRegistry.ts` with the three-state result + cache.
18. Operator confirmation UI for a proposed registry match. No auto-match ships.

---

## Notes

### Fidelity impact

Net positive but *narrow*, and the report must not oversell it. Today every MCP server is
`lost` or `partial` via the Track B direct-API rebuild. After this, exactly one class —
third-party, publicly reachable, operator-configured — can become genuinely `mapped`. In the
live tenant that is **1 of 5 servers, 2 of 10 bindings**.

Every path emits a note. Nothing is dropped silently:

- Microsoft-hosted → `lost`, reason named.
- No connector id (D365 CC) → `lost`, reason named.
- Configured but unreachable → `needs-review`, blocker + fix named.
- `'specific'` partially advertised → `partial`, **missing tools named individually**.
- Registry path used → the note must say the allow-list is enforced **by instruction only**.
- Raw-URL path used → the note must say the deploy path is **not yet live-verified** until
  S3's probe passes.

Guard against **double-reporting**: `orchestrator.ts:3220` already writes an MCP note based on
the Track B rebuild. Extend that one block; a second note from Track C would make one server
appear twice with two different verdicts — precisely the "two verdict tables" failure this
project has already been bitten by.

### Migration / backward compatibility

- `serverUrl?` is optional ⇒ every existing `connectorCredentials` record stays valid.
- No `stagedAgents` change ⇒ rows staged before this ships replay correctly; they simply have
  no MCP spec until the operator configures the server, which is the honest outcome.
- No `AgentIR` change ⇒ `agentIRCache` unaffected.
- Already-deployed agents are unaffected (none carries a working MCP toolset — P0 proves it).
- S0 *changes* observable behaviour for MCP agents, from "deploy fails" to "deploys without
  MCP". That is the point, and it belongs in the PR description.

### Risks and unknowns, ranked

1. **P0-1 is live now.** 5 of 59 filefuze agents cannot complete an ADK deploy. Highest
   severity, cheapest fix, ships first. Confirm the failure signature in a real run log before
   claiming the fix — a filtered log showing nothing proves nothing.
2. **The raw-URL path has never executed.** P0-2 proves it structurally. Everything in S2/S3
   rests on `McpToolset` + `StreamableHTTPConnectionParams` behaving as documented, against a
   real third-party server, from inside a Reasoning Engine. **Unproven end to end.** No report
   may claim an MCP server is migrated on this path until S3's live probe passes.
3. **The registry path failed its only live test**, 2026-09-07, `calendarmcp.googleapis.com`:
   toolset construction succeeded, the session died with "Session terminated". Best current
   explanation is gcloud's shared OAuth client being blocked from the Calendar scope for a
   *personal ADC login* — a deployed engine authenticates as its own SA and should not hit it.
   **That has never been re-confirmed with a service-account run.** Do not present the registry
   path as "the proven one" on the strength of a test that failed.
4. **We do not know HubSpot's real MCP endpoint.** `listCustomConnectors` yields
   `api.hubapi.com`, a host. The actual route is vendor-specific and not recoverable from the
   swagger. The design's answer is "the operator supplies it" — which is correct but means the
   feature cannot be demoed until someone obtains a working URL + token. **This gates S2's
   first real test.**
5. **Agent Registry listing API is unknown.** No client code, no verified method. S4 must not
   start before a spike returns a real response. Researcher confirmation required.
6. **Advertised ≠ callable.** Even a fully green pre-flight can precede 403s at inference.
   Structural; cannot be engineered away. Handled by never claiming more than "advertised" in
   the report.
7. **Our egress ≠ the engine's egress.** A server behind an IP allowlist passes pre-flight from
   our server and fails from the Reasoning Engine. Handled by wording, not by a fix.
8. **Registry-path tool restriction is instruction-only.** A sufficiently determined model can
   call outside the allow-list. This is a real fidelity/security gap in ADK, not in this code.
   It is why the raw-URL path is the *stronger* option and why a registry match must be
   operator-confirmed rather than silently preferred.
9. **Token scope creep.** An MCP bearer token is often broader than the 26 tools DealMate was
   allow-listed for. The allow-list constrains the *agent*, not the *credential*. Worth saying
   in the UI copy next to the token field.

### Decisions to record in `.claude/memory/decisions.md`

1. MCP destination config is keyed by `connectorId` and stored in the existing
   `connectorCredentials` collection — no new collection, no credential group.
2. The operator-supplied MCP `serverUrl` lives in the DB record, **not** in `AgentIR` and
   **not** in Secret Manager. `McpBindingIR.serverUrl` stays a source-side hint used only as
   UI placeholder text.
3. `ConnectorCredentialRecord.serverUrl?` — additive DB schema change. **Needs explicit
   sign-off.**
4. Microsoft/Power-Platform-hosted MCP servers are a declared hard limitation, reported and
   never attempted, via a single `classifyMcpServer()` classification point.
5. The raw-URL path enforces `toolSelection: 'specific'` **by construction** (`tool_filter`);
   the registry path enforces it **by instruction only**. Raw URL is therefore the stronger
   fidelity path, and a registry match is operator-confirmed, never automatic.
6. An unbuildable MCP entry is never emitted into `AdkSpec.mcpTools`, because one bad entry
   aborts all tool wiring for the whole agent.

### Open questions for the Researcher

- Agent Registry: REST method + version to list a project's registered MCP servers; required
  IAM role; is it per-location or global-only; does an entry expose its sanctioned tool list?
- Does `AgentRegistry.get_mcp_toolset()` in a *newer* google-adk than 2.8.0 accept a
  construction-time tool filter? If it ever does, decision 5 is revisited.
- HubSpot MCP: the real endpoint path and the token type it expects (PAT vs OAuth access
  token).
- Is any Microsoft-hosted MCP endpoint reachable with a bearer token from outside Power
  Platform? A single positive result reopens the working assumption.
