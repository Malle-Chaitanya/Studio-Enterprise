# Gemini Enterprise — Onboarding, Licensing & Delivery Notes

Deferred work. Captures the licensing model, the customer-delivery model, and the
production-grade auth setup so we can wire it up properly later. **For now we're
using the 30-day Gemini Enterprise trial** (see the last section).

---

## 1. The licensing model (the thing that trips everyone up)

Two independent layers. Confusing one for the other caused all the churn:

| Layer | Scoped to | Notes |
|---|---|---|
| **Gemini Enterprise subscription / seats** | the **organization** (or a standalone project if "No organization") | grants users the license. Reusable by any project *in the same org*. |
| **Agent-creation quota** (the "quota exceeded" error) | the **individual project** | each project gets its own allotment of agent slots. |

**Key consequences:**
- A subscription in org X covers every project in org X. It does **not** cross orgs.
- If a project is under **"No organization"**, its subscription is effectively tied to that project alone — there's no org node for other projects to inherit from.
- Being **Owner** on a project ≠ having a **seat**. Owner = permission to configure. Seat = license quota. Both are needed.

### What `RESOURCE_EXHAUSTED / "Agent creation quota exceeded"` actually means
It is **NOT** "no subscription." It means **the project's agent slots are full** — you've
created the max number of agents that subscription/tier allows in that project.
Fix by either (a) deleting unused agents to free slots, or (b) raising the tier/seats.

Parking-garage analogy: subscription = you paid & the gate opens; quota = number of
parking spots. All spots taken → you still can't park even though you paid.

---

## 2. Facts about zara's environment (our demo sandbox)

- Zara's working Gemini Enterprise app: **"Zara Z's Team"**, engine id **`agentspace-engine`**.
- Lives in project **`the-dispatch-0vzc3`** = project number **`860501065102`** (same project).
- That project is under **"No organization"** (standalone). Subscription lives *in this project*.
- Webapp cid: `96c55072-784e-4f9d-b718-d4cd8b416666`.
- The "quota exceeded" we hit was here → slots full, subscription fine.

---

## 3. Customer-delivery model (answers "No organization — how do we deliver?")

**We never hand our project to a customer.** Zara's `the-dispatch-0vzc3` is only *our*
practice sandbox; its org status is irrelevant to customers.

A real customer **already owns their own Gemini Enterprise** — their org (e.g. `acme.com`),
their project, their subscription/seats. Delivery is:

1. Customer has Gemini Enterprise (their org / project / engine). *(their concern, already set up)*
2. Customer **grants CloudFuze's service account access** to their project
   (IAM role: **Discovery Engine Admin**) — the onboarding step — **or** their admin
   signs in via **OAuth**.
3. Tool **auto-discovers their engine** (client-agnostic, already built) and migrates
   their Copilot agents **into their existing Gemini Enterprise**.

> Moving-company analogy: we don't need our own house to move furniture into yours.

### CloudFuze's own SaaS infra (the one legit "org" for us)
The only place *we* want a proper org is where **CloudFuze's service account** lives —
ideally a CloudFuze-owned GCP project under a `cloudfuze.com` org. That SA is the identity
customers grant access to. One-time product-infra setup, separate from any demo.

---

## 4. Production-grade auth (what "production" means here)

Production = **OAuth (client admin sign-in) + Service-Account direct IAM grant**.
No bypass, no hardcoded impersonation, no DWD hack.

| Piece | Production | Bypass (dev only) |
|---|---|---|
| Client admin sign-in | **OAuth** (`GOOGLE_AUTH_MODE=oauth`) | skipped, hardcoded email |
| How the SA gets in | **direct IAM** (SA granted Discovery Engine Admin on the project) | DWD impersonation of a user |
| Writes run as | the **SA itself** (direct token, no `subject`) | SA impersonating a user |
| Multi-tenant / commercial? | ✅ yes | ❌ no |

The orchestrator already detects this: if the SA has IAM on the project → direct SA token;
otherwise it falls back to impersonation. So the production `.env` is simply:

```env
GOOGLE_AUTH_MODE=oauth
GOOGLE_SA_KEY_FILE=<path to the SA key that has IAM on the target project>
# no GOOGLE_IMPERSONATE_EMAIL, bypass block commented out
```

---

## 4b. Destination resolution — production-grade (client-agnostic)

**Never pin the engine in `.env`.** `GEMINI_ENGINE` is a global override — pinning it
forces every client onto one engine, which breaks multi-tenant. In production it is
**unset**; the engine is discovered per-client at runtime.

How it resolves (no hardcoded engine ids anywhere):
- **Project**: `discoverGeminiProject()` scans the signed-in admin's accessible projects
  and **lists engines** in each (it does NOT probe a hardcoded engine name like
  `agentspace-engine`). Picks a project with a chat/assistant engine, else the first
  project with any engine. `GEMINI_PROJECT_FALLBACK` is a last-resort fallback only.
- **Engine**: `resolveDestination()` lists the project's engines and picks one
  (chat/assistant preferred, else search, else first). Used by the orchestrator AND the
  connect-time reachability check.
- **Reachability check** (`verifySaReachable` in `routes/auth.ts`): tries **direct IAM**
  first (SA granted a Discovery Engine role on the client project — the production model),
  then **DWD** (impersonate the admin) as fallback. Engine always discovered.

`.env` in production:
```env
GOOGLE_AUTH_MODE=oauth
GOOGLE_SA_KEY_FILE=<SA with IAM on the client/target project>
# GEMINI_ENGINE unset (discovered per-client)
# GEMINI_PROJECT_FALLBACK optional — fallback only
```

TODO (not yet wired): persist the client's explicit project+engine *selection* (the
`/api/destination/*` routes already list them) into the session so the orchestrator uses
the chosen destination instead of auto-pick. Today it auto-discovers, which is fine for
single-engine projects.

## 5. Fix options for reusing zara's existing subscription (deferred)

### Option A — production-grade, reuse zara's sub (RECOMMENDED for later)
Create a dedicated SA **inside `the-dispatch-0vzc3`** and use direct IAM:
1. IAM & Admin → Service Accounts (project `the-dispatch-0vzc3`) → Create SA `csge-migrator`
   → role **Discovery Engine Admin** → create JSON key, download.
2. `.env`:
   ```env
   GOOGLE_AUTH_MODE=oauth
   GOOGLE_SA_KEY_FILE=C:/Users/ChaitanyaMalle/CS_GE/the-dispatch-sa.json
   GEMINI_PROJECT_FALLBACK=860501065102
   GEMINI_ENGINE=agentspace-engine
   ```
3. Free the full slots (that's the quota error):
   ```bash
   cd server
   npx tsx src/spikes/_diag_agents.ts 860501065102                    # list what's using quota
   npx tsx src/spikes/_diag_agents.ts 860501065102 delete-matching "test"
   npx tsx src/spikes/_diag_agents.ts 860501065102 delete <agentId>   # or one at a time
   ```
4. Live 1-agent migration → creates as the SA on zara's real subscription.

### Cleanup helper reference (`src/spikes/_diag_agents.ts`)
- `npx tsx src/spikes/_diag_agents.ts <project>` — list agents occupying quota (read-only)
- `... <project> delete <agentId>` — delete one, free a slot
- `... <project> delete-matching "<substr>"` — delete all whose displayName contains substr
- Identity: uses `GOOGLE_SA_KEY_FILE`; impersonates `GOOGLE_IMPERSONATE_EMAIL` or last
  session's gEmail if set, else the SA directly.

---

## 6. WHAT WE'RE DOING NOW — 30-day trial

Using the **30-day Gemini Enterprise trial** on the fresh project
`studio-enterprise-migration` (SA `studio-enterprise-migration@…` is already **Owner** =
direct IAM, production auth). Steps:

1. Console (project = studio-enterprise-migration) → **AI Applications → Create App**
   → **Gemini Enterprise** card ("Try free for 30 days") → location **global**.
   The trial = this project's own subscription (dedicated fresh quota).
2. Copy the **Engine ID** from the created app.
3. `.env` (already production-wired — just add the engine id once known):
   ```env
   GOOGLE_AUTH_MODE=oauth
   GOOGLE_SA_KEY_FILE=C:/Users/ChaitanyaMalle/CS_GE/service_account.json
   GEMINI_PROJECT_FALLBACK=<studio-enterprise-migration project number>
   GEMINI_ENGINE=<engine id>
   ```
4. Verify:
   ```bash
   cd server
   npx tsx src/spikes/_diag_project.ts studio-enterprise-migration   # expect: 1 engine(s)
   ```
5. Run a live 1-agent migration → creates as the SA (direct IAM), on the trial's fresh
   quota. Clean production-style run.

> When the trial ends: convert to paid, or switch `.env` back to Option A (zara's sub)
> using the cleanup helper to free slots.
