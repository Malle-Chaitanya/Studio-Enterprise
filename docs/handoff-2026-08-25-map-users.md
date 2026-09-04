# Handoff — Map users rewrite + licence-fetch findings

**Date:** 2026-08-25
**Branch:** `business` (HEAD `c629d94`)
**State:** everything below is **uncommitted**. Nothing pushed.

`web/**` must not be committed without ui-info / chaitanya's OK — they own that tree.

---

## 1. What changed

### `web/src/pages/v2/MapUsersV2.tsx` — 428 → 208 lines

Stripped to one job: fetch the licensed destination accounts, auto-match each source
person, let a human correct any row.

**Removed:** the 3-cell Band, the `N of M mapped` SelectBar summary, Accept-all, Undo,
the non-human Fold, the `suggestion` state and its `Use suggestion` button, the whole
Inspector, the Sync button, `readAgo`.

**Kept, deliberately** — each would break the feature silently if cut:

| Kept | Why |
|---|---|
| per-row dropdown | auto-match with no correction path is a one-way door; a wrong match hands agent ownership to the wrong human |
| `licence unreadable` chip | when the seat read fails the server filters **nothing**; auto-matching over that unfiltered list maps people to accounts with no seat and they render as `mapped` |
| `list truncated` chip | the candidate read is capped; past the cap auto-match skips people |
| empty state | a directory-consent failure and an empty tenant are otherwise identical |

**Added:** a `useEffect` that calls `source.users.autoMatch`, saves, calls `markProgress`,
toasts `Matched N of M.` Guarded by a `useRef` keyed on the unmatched-email set so a
background revalidate cannot overwrite a correction. Only people with **no** saved mapping
are sent.

**Also:** `inspector={null}` and row class `v2-row mapuser`.

### `web/src/v2/data/{types,api,fixture}.ts`

`autoMatch(session, people)` added to `UsersSource`. The api implementation calls
`suggestIdentityMap` — the matcher stays server-side. The fixture returns its canned
`suggested` values.

### `web/src/design/v2.css`

```css
.v2-work:not(:has(.v2-insp)) { grid-template-columns: 1fr; }
.v2-row.mapuser .v2-select { max-width: none; width: 100%; }
```

First reclaims the 300px inspector track on a page with no inspector (Map users is the
only page passing `null`; every other v2 page renders a real `<Inspector>`). Second fixes
option text truncating mid-address — the global `.v2-select` cap is 190px and the address
is the half that disambiguates two people with the same name.

### Server (unrelated to Map users, from earlier this session)

- `server/src/services/verify.ts` — removed the dead `:assist` call. That endpoint does
  not exist (404 on v1alpha/v1beta/v1); the real method is `:streamAssist`, which
  **cannot be aimed at a single agent** — a bogus agent id returns an identical answer.
  Switching to it would have marked every low-code agent `verified`, which is worse than
  the bug. Now returns `unknown` with the real reason.
- `server/src/services/verify.test.ts` — 4 tests replacing the one that mocked a 200 from
  the non-existent endpoint.
- `server/src/orchestrator.ts` — precedence inversion: line ~2643 unconditionally
  overwrote the ADK worker's real tool list, so `discovery_engine_search` was never
  expected and agents falsely reported `wrong_agent_tools`. Now gated on
  `workerReportedToolNames`.
- `server/src/server.ts` — request logging (there was none, which is why "watching the
  logs" showed nothing). Uses `req.path`, not `originalUrl`, because the query carries
  the session id.

---

## 2. Verification

| Check | Result |
|---|---|
| `web` `tsc --noEmit` | clean |
| `server` `tsc --noEmit` | clean |
| `server` `npm test` | **418 passed, 36 files**, 0 failures |
| Map users rendered | fixture path, auto-match fires, toast `Matched 2 of 6.`, toggle flips `Show all users` ⇄ `Licensed only` |
| Browser console | clean (only two pre-existing React Router v7 future-flag warnings) |

Note: `.claude/rules/testing-standard.md` still claims 118 tests / 10 suites. Actual is
418 / 36. Stale.

---

## 3. Open bugs found in the licence-fetch path — NOT fixed

All three are real and were read out of the source, not inferred.

### 3.1 `truncated` is computed after filtering

`server/src/routes/identity.ts:288`

```ts
truncated: out.length >= max,
```

`max` (200) caps the **directory** read; `out` is what survives the licence intersection.
A tenant with 500 users where 40 hold seats returns `out.length = 40`, so
`truncated: false` — even though 300 users were never looked at. The `list truncated`
chip can essentially never fire. Should test the pre-filter count.

### 3.2 A failed directory read renders as `0 licensed accounts`

`server/src/routes/identity.ts:296` returns **HTTP 200** with `{ users: [], error }`, and
the client discards it — `web/src/v2/data/api.ts:399`:

```ts
.catch(() => ({ users: [] } as ...))
```

`filter` ends up `undefined`, so the chip falls through to `0 licensed accounts`. That is
a failure presenting as a fact. Unknown rendered as zero.

### 3.3 Auto-match does not consult licences at all — **worsened by this session's change**

`POST /api/identity/suggest` verifies candidates against
`profile.google.verifiedUserEmails`, which `server/src/services/organizationProfile.ts:70`
builds from:

```ts
const users = await listWorkspaceUsersAsAdmin(session.gEmail, { max: 500 });
```

That is the **raw Workspace directory**, not `listLicensedPrincipals`. The dropdown filters
on seats; auto-match picks from anyone with a Google account. Two different answers to
"who can own an agent."

This was tolerable while the match was a *suggestion a human accepted*. This session made
it **apply silently**, so a person can now be mapped to a seatless account and the row
reads `mapped` with nobody having looked at it.

**Fix:** intersect the suggestion with the licensed set before saving.
**Open decision:** what to do when `licenceCheck === 'unavailable'` (the seat read failed).
Apply anyway and rely on the chip, or leave rows unmatched? The code comments show that
read fails routinely, so blocking on it would disable the feature often. Recommend apply +
chip, but this is the user's call and was not decided.

---

## 4. What licence is actually being read

The **Gemini Enterprise seat** — not a Workspace or Microsoft licence.

```
GET https://discoveryengine.googleapis.com/v1alpha
    /projects/{project}/locations/{LOCATION}
    /userStores/default_user_store/userLicenses?pageSize=1000
```

Kept where `licenseAssignmentState === 'ASSIGNED'`, keyed on lowercased `userPrincipal`,
paged to 5000 (`server/src/services/gemini.ts:352`).

Read **once per paired project and unioned** — one tenant can pair different environments
to different Gemini projects, each with its own seat pool (confirmed live 2026-08-24:
three projects, three disjoint lists).

Auth order per project: direct IAM first, DWD second. Both are needed — an org with
`constraints/iam.allowedPolicyMemberDomains` cannot grant an outside SA any role, so
direct IAM is permanently unavailable there, not merely slow. Observed 2026-08-23 on
project `505103737920`: bare SA resolved zero engines, the call 403'd, licence filtering
silently switched itself off while DWD worked the whole time.

**Two caveats the code is explicit about:**

- `default_user_store` is a **guess**. `userStoreBase()` hardcodes it; the doc comment at
  `gemini.ts:303` calls it "the one unverified piece." A wrong id → 404 → `null` →
  filtering silently off.
- Server-side `filter=` is **broken** on this API. Confirmed live 2026-08-22:
  `filter=user_principal="{email}"` returns 200 and matches nothing against a store that
  demonstrably holds that principal as `ASSIGNED`. Produced a real false negative on an
  actively-logged-in licensed user. Hence fetch-all-and-match-locally.

Failure is modelled honestly: `null` = "couldn't tell", empty set = "nobody licensed",
with 429/503 backoff and a per-page retry budget reset.

---

## 5. Other known-open items

- **`UserRow` has no `kind` field.** Groups and service accounts are indistinguishable from
  people in the data, so they show as `not matched` forever and inflate the count. The only
  client-side filter available is guessing from text (`(group)`, `svc-`), which misfires
  both ways on a real tenant — a vanished person means their agents migrate ownerless with
  nothing on screen saying so. Correct fix: `kind: 'user' | 'group' | 'service'` populated
  server-side where Dataverse/Graph knows the principal type. Same field the groups UI
  needs — do it with that work.
- **Groups have no UI at all.** `resolvePermissions` handles `group-match`, the API accepts
  `groups` overrides, and runs log `0 group override(s)`. Biggest real gap on this screen.
- **`identityMappings` has no backfill.** Rows written before `88e0334` lack
  `geminiProject`, so saved overrides stop resolving after deploy. Decide before next deploy.
- **ReportV2 tools note** — this session changed it to `across N agents`, which is *worse*
  for single-agent runs. Needs redoing.
- **Toast leaves a bare grey ✓ mid-fade.** `setToast('')` clears the text at 2.6s while the
  container is still transitioning out. Lives in `V2Layout`, shared by every v2 screen.
- **Four secrets exposed in an Aug 22 screenshot are still not rotated:**
  `MS_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `CONFLUENCE_TOKEN`, `MS_GRAPH_CLIENT_SECRET`.

---

## 6. Running it locally

```bash
cd server && npm run dev     # :8080
cd web    && npm run dev     # :5173
```

Mongo must be up or sign-in cannot be verified — `appUsers` lives there, and the server
reports `"db": false` in `/api/health`. It connects at boot and **does not retry**, so
start Mongo first:

```bash
docker start csge-mongodb    # 27017/tcp -> 127.0.0.1:27019
```

Accounts in `csge.appUsers`: `admin@cloudfuze.com` (admin), `demo@cloudfuze.com` (user).
Passwords are bcrypt-hashed; they came from `SEED_ADMIN_PASSWORD` / `SEED_DEMO_PASSWORD`
in `server/.env` at first seed. Deleting the rows and restarting reseeds from `.env`.

Pages:

- fixture, no login, no DB — `http://localhost:5173/v2/map-users?session=demo&fixture=1`
- real data — sign in, then Map users with a live `session` id

**Gotcha:** `npm run dev` spawns `tsx` as a child. Killing the npm wrapper leaves the
child holding :8080, and the next start dies with `EADDRINUSE` while the *old* process
keeps answering `/api/health`. Kill the PID from `netstat -ano | grep ":8080 "`.

---

## 7. Suggested next steps, in order

1. Fix 3.3 — intersect auto-match against the licensed set. It is the one that produces a
   silently wrong migration. Settle the `unavailable` question first.
2. Fix 3.2 — surface the fetch error instead of rendering `0 licensed accounts`.
3. Fix 3.1 — compute `truncated` pre-filter.
4. Get ui-info's OK, then commit `web/**` separately from the server changes.
5. Add `UserRow.kind` with the groups UI work.
