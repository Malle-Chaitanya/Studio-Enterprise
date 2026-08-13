# Design: Edition-Aware + Sharing-Aware Business-Edition Destination

> **Status:** Design (no app code written yet). Grounded in the real codebase.
> **Scope:** INSERT / destination side only. Extraction and `AgentIR` are untouched.
> **Trigger:** A prior migration targeted a **Standard-edition** Gemini account; migrated
> agents existed but never appeared in the gallery (silent-success trap). The tool is
> moving to a **Business-edition** client (admin `mia@cloudfuze.com` + a regular user seat).

---

## Plain-English summary

For a migrated agent to actually be usable by a real person, **two independent things**
must both be true — and today the tool checks neither honestly:

1. **Edition (gallery gate)** — On **Business** edition, migrated agents show up in the
   Gemini gallery. On **Standard/Plus**, they exist but are hidden in a governed gallery.
   That is the exact trap the earlier migration hit.
2. **Sharing (access gate)** — The agent must be **shared with the specific user's
   account**, and that user must hold a Business **seat/license**. Creating and
   gallery-listing an agent does nothing if this person was never granted access.

The customer **never edits our environment**. They sign in with **their own admin**
(`mia@`) and grant scopes; the tool **discovers** their project, engine, and (as best it
can) their edition at runtime. "Target Business" therefore means: *detect the edition at
connect time, and refuse to silently claim success when agents won't be visible/usable* —
warn, get explicit acknowledgment, and report the truth per agent.

**Honest limits up front:** Google's Discovery Engine API exposes **neither an "edition"
field nor a per-user seat/license fact**. So both detections are **best-guess +
confirm/needs-review**, never silent assumptions — matching the project principle *"the
tool recommends, it does not silently decide."*

`mia@cloudfuze.com` and the user seat are just this customer's shape — nothing about them
is hardcoded; both belong to one `appUserId`-scoped tenant.

---

## The two gates (core mental model)

A migrated agent is **user-usable only if BOTH gates pass**. They are decided and checked
in different places:

| Gate | Controls | Decided at | Checked at |
|------|----------|-----------|-----------|
| **Edition (gallery)** | Whether the agent is *listed* in the gallery (Business lists PRIVATE; Standard/Plus hide it) | `detectEdition` at connect | orchestrator guardrail gate + verify Level-3 (`galleryVisible`) |
| **Sharing (access)** | Whether *this user's account* may open the agent | `shareAgent` audience in the INSERT loop | verify Level-4 user check + `MigrationResult.sharedWith` |

Neither implies the other. Business + not shared = visible in gallery but denied on open.
Shared on Standard = openable by direct link but not gallery-listed. The report must show
**both** columns, per agent, honestly.

---

## Where it sits across the phase boundary

Edition and sharing are **destination / INSERT concerns only**. The EXTRACT phase
(Dataverse → `stagedAgents`) stays edition-agnostic and sharing-agnostic — a staged row is
platform-neutral and could be inserted into any edition later. This preserves the
"staging decouples the phases / retryable" invariant. **Do not** bake edition or sharing
into `AgentIR` or into the staged `mapped.fidelityNotes`; they are computed and attached
in Phase 2, on the `MigrationResult`, at insert time.

```
CONNECT (routes/auth.ts googleCallback)
  └─ verifySaReachable(project, admin)          ← EXISTING seam; resolves engine
        └─ detectEdition(project, saToken, gToken)   ← NEW, best-effort
              → session.geminiEdition / editionSignal / editionConfirmed

DESTINATION (routes/destination.ts /validate)
  └─ returns edition + editionSignal + visibilityWarning   ← UI shows badge

── phase boundary (staging DB) — edition/sharing NOT crossed ──

INSERT (orchestrator.execute, right after resolveDestination @ ~line 227)
  ├─ guardrail gate: edition ≠ business AND not acknowledged → abort Phase 2
  ├─ per agent create
  ├─ shareAgent(dest, saToken, agentId, audience)  ← targeted, structured result
  ├─ append gallery-visibility + user-access FidelityNotes to result.fidelity
  └─ verifyAgent(dest, saToken, agentId, edition, asUser?)  ← Level-3 + Level-4
```

**`AgentIR` change: NO.** **DB-schema change: YES — additive/optional only, no migration.**
**`ProgressEvent` union: NO new event kind** (edition banner = `log`; per-agent status
rides on the existing `agent` result + its `fidelity[]`).

---

## Edition detection — options ranked (honest caveats)

The Discovery Engine API has **no edition field** (a live GET returns only
name/displayName/description/icon/times/state/starterPrompts/lowCodeAgentDefinition/
sharingConfig/activeRevision/agentIdentityInfo). Every option is a *signal*, labeled by
confidence.

- **Option A — Subscription/Billing lookup (highest confidence; needs a scope). PRIMARY.**
  Query the Workspace/Cloud subscription for the Gemini Enterprise SKU. Implement as a
  best-effort helper in `auth/google.ts` mirroring `getWorkspaceDomains()` (try → 403 →
  `unknown`). Definitive SKU → `signal: 'subscription-api'`, high confidence.
  **Researcher must confirm** the exact API + SKU strings that distinguish
  Business/Standard/Plus and the scope they need.
- **Option B — Managed-org / domain heuristic (no scope; low confidence). HINT ONLY.**
  Managed Workspace orgs typically get Standard/Plus; non-managed can be Business. **Weak
  and self-contradicting** for our own case (cloudfuze.com is managed yet `mia@` is
  Business), so it may *inform* the guess but must **never** decide.
- **Option C — Behavioral probe. REJECTED at connect** (mutating, quota-costly, slow).
- **Option D — Explicit admin confirmation. THE GATE.** Present the best guess and ask the
  admin to confirm before a real insert. Stored as `editionConfirmed`.

**Chosen strategy:** A when available → auto-confirm Business; else B for a best guess + D
for explicit confirmation. Never silently assume Business.
`detectEdition()` → `{ edition: 'business'|'standard'|'plus'|'unknown', signal, confidence, detail }`.

---

## Guardrail behavior (honesty + consent, not a hard block)

A non-Business migration may still be legitimate (agents work by direct link). So the gate
is *honesty + consent*. At the insert gate (orchestrator, after `resolveDestination`):

1. **business (confirmed):** proceed. Each result gets a `gallery-visibility` FidelityNote,
   `status: 'mapped'` — "Business edition — listed in the org gallery."
2. **standard/plus OR unknown/unconfirmed, and NOT acknowledged:** **abort Phase 2 before
   any create**, mirroring the existing `saOk`-fail abort path (`emitLog('warn')`,
   `finishRun(runId, msg, 'aborted')`, emit `done`). Client-facing code:
   `edition_visibility_unconfirmed`.
3. **standard/plus AND acknowledged** (customer chose "migrate anyway — direct-link only"):
   proceed, but every result gets a `gallery-visibility` note, `status: 'needs-review'`,
   explaining the agents work by direct link but won't appear in the Standard/Plus gallery.
   One prominent `emitLog('warn')` banner up front.

---

## Sharing — make it a first-class, targeted, recorded step

**Today (grounded):** the INSERT loop calls
`result.shared = await shareAgent(dest, saToken, create.agentId)` (orchestrator ~line 504).
`shareAgent()` (services/gemini.ts ~lines 149-158) does one PATCH with
`updateMask=sharingConfig`, hardcoded `{ sharingConfig: { scope: 'ALL_USERS' } }`, returns
a bare `boolean`. So sharing today is coarse ("all users in org"), performed as the
**SA/admin** identity, and recorded as just `shared: boolean` — **no record of audience**.

**Design:**
- `shareAgent(dest, saToken, agentId, audience): Promise<{ shared, sharedWith, scope, note? }>`.
- `ShareAudience` (client-agnostic, from plan/session, never hardcoded):
  `{ kind: 'all_users' } | { kind: 'principals'; emails: string[] } | { kind: 'group'; email: string }`.
  Default `{ kind: 'all_users' }` preserves current behavior. `mia@` + the user seat are
  example values read from `DestinationOptions.shareAudience`.
- **Researcher-confirm:** whether v1alpha `sharingConfig` supports anything narrower than
  `ALL_USERS`. If per-principal sharing isn't expressible on the Agent resource, the tool
  **cannot fully automate** it and must say so (needs-review) — it must **not** silently
  fall back to `ALL_USERS` while claiming it targeted the user.
- **Record who:** `MigrationResult.sharedWith?: ShareAudience`, `sharedScope?: string`, set
  from the `shareAgent` outcome and persisted on the staged row. The report states the
  audience, not just a checkmark.

---

## Verify — check from the USER's perspective

**Today:** `verifyAgent()` (services/verify.ts) runs Level-1 GET + Level-2 assist probe
using **`saToken`** (the SA / DWD-impersonated admin). Proves the *admin* can see/talk to
the agent — says **nothing** about the regular user seat.

**Design:**
- **Level-3 — gallery visibility inference:** capture the agent `state` from the Level-1
  GET; compute `galleryVisible` from `state` + edition (Business lists PRIVATE → true;
  Standard/Plus hide PRIVATE → false; edition unknown → `undefined`, never a false positive).
- **Level-4 — user-perspective check (when possible):** if DWD can impersonate the target
  user seat (same mechanism as the admin via `getSaToken(impersonate)`), mint a token as
  that user and re-run the GET. 200 → `userVisible: true`; 403/404 → `userVisible: false`.
  **This is the only way to *assert* rather than *assume* user access.**
- **When impersonation isn't possible:** return `userVisible: 'unknown'` and emit a
  `user-access` FidelityNote, `status: 'needs-review'` — "Verified as admin/SA only; could
  not confirm the target user seat can open this agent." *Admin-verified is not
  user-verified.*
- Extend `VerifyResult` with `state?`, `galleryVisible?`, `userVisible?: boolean | 'unknown'`;
  copy to `MigrationResult`. Signature: `verifyAgent(dest, saToken, agentId, edition, asUser?)`.

---

## Seat / license precondition (honest)

A Business **seat/license** is required for the user to see shared agents at all — and,
like edition, it is **not reliably exposed on the Discovery Engine API**.

- **Best-effort detection only** via the Option-A subscription/Admin-SDK signal, if
  available; otherwise we **cannot** detect it — say so.
- **Practical proxy:** the Level-4 user-impersonation check — a user without a seat
  typically 403s, routed to `userVisible: false/unknown` + a `user-access` needs-review
  note. Plus a one-line report caveat: "User-usability assumes the target seat holds a
  Business license; the tool cannot fully verify license assignment." Never a silent success.

---

## Multi-tenant / new-account cleanliness

- `mia@cloudfuze.com` is **just another `appUserId`-scoped session**. Edition is discovered
  fresh per connect and stored on that session only; nothing hardcoded.
- **No leakage from the old Standard account:** sessions are per-connect and TTL'd; edition
  is re-detected every connect; staged rows carry no edition, so an old Standard run can't
  taint a new Business run.
- **One risk to close:** `defaultDestination()` / `resolveDestination()` honor
  `GEMINI_ENGINE` / `GEMINI_ASSISTANT` env overrides (gemini.ts ~lines 178-184, 233-237).
  These must be **unset** in any multi-tenant deployment (dev-only escape hatch) or all
  tenants get pinned to one engine — a client-agnostic violation.

---

## Files-to-change (both axes; layer-labeled)

| # | File | Layer | Change |
|---|------|-------|--------|
| 1 | `server/src/types.ts` | types | Add `GeminiEdition`, `EditionInfo`, `ShareAudience`; add optional `galleryVisible?`, `verifyState?`, `userVisible?`, `sharedWith?`, `sharedScope?` to `MigrationResult`; add `shareAudience?` + `acknowledgeNonBusinessVisibility?` to `DestinationOptions`. **`AgentIR` untouched.** |
| 2 | `server/src/auth/google.ts` | auth | Best-effort `getGeminiSubscription()` (mirror `getWorkspaceDomains()`, 403 → `unknown`). |
| 3 | `server/src/services/edition.ts` **(new)** | service | `detectEdition(project, saToken, gToken): Promise<EditionInfo>` — A → B → unconfirmed; never throws; no hardcoded ids. |
| 4 | `server/src/sessionStore.ts` | store | Add optional `geminiEdition?`, `editionSignal?`, `editionConfirmed?` to `Session`. |
| 5 | `server/src/routes/auth.ts` | route | After `verifySaReachable`, call `detectEdition`; persist on session; expose on `/session/:id`. |
| 6 | `server/src/routes/destination.ts` | route | `/validate` returns `{ edition, editionSignal, visibilityWarning }`; snake_case codes; keep `appUserId`/session guards. |
| 7 | `server/src/routes/migrate.ts` | route | Accept `acknowledgeNonBusinessVisibility` + `shareAudience` in plan body; thread into `plan.destination`; validate emails; no hardcoded defaults. |
| 8 | `server/src/services/gemini.ts` | service | `shareAgent(dest, saToken, agentId, audience)` → structured `{ shared, sharedWith, scope, note? }`. Narrower audience only if Researcher confirms; else honest `note`, never silent `ALL_USERS` masquerade. |
| 9 | `server/src/services/verify.ts` | service | Level-3 gallery inference + Level-4 user-perspective check; extend `VerifyResult`; `asUser?` param. |
| 10 | `server/src/orchestrator.ts` | orchestrator | Guardrail gate after `resolveDestination`; store edition + signal on run; pass `shareAudience` to `shareAgent`; store `sharedWith`/`sharedScope`; pass `asUser` to `verifyAgent`; append `gallery-visibility` + `user-access` FidelityNotes; persist onto staged row. |
| 11 | `server/src/services/report.ts` | service | Per agent: **"Gallery-visible"**, **"Shared with"**, **"User can open"** shown independently and honestly. |
| 12 | `web/src/api.ts`, `web/src/pages/SelectMap.tsx` | web | Edition badge; non-Business acknowledgment; share-audience input; two-gate result display. (`/qa` covers.) |

---

## Open questions / risks (for `/investigate` or the `researcher` agent)

1. **Edition API (blocking A):** exact Google API + SKU strings distinguishing
   Business/Standard/Plus, and the OAuth scope they need. Until confirmed, A degrades to
   `unknown` and we rely on B + D — safe (defaults to "confirm before insert").
2. **Narrower sharing:** whether v1alpha Agent `sharingConfig` supports per-principal/group
   sharing or only `ALL_USERS`. Determines whether §sharing can auto-target the user seat or
   must report needs-review.
3. **User impersonation for verify:** whether DWD is authorized for the target user seat in
   this client. If not, Level-4 is `unknown` (needs-review), never a false "user-visible."
4. **State-based gallery inference** is itself heuristic — reported as inference, `unknown`
   when edition is unknown.
5. **Deployment guard:** ensure `GEMINI_ENGINE`/`GEMINI_ASSISTANT` are unset in multi-tenant
   deployments.

## Fidelity & compatibility

- **Net honesty gain:** closes the silent-success hole. New `gallery-visibility` and
  `user-access` FidelityNotes are the mechanism; nothing dropped silently.
- **Backward-compatible:** all schema additions are optional; no data migration; old
  Standard-account runs remain readable; `stagedAgents` unchanged so already-staged rows
  still insert (they pick up edition/sharing annotation at insert time).
