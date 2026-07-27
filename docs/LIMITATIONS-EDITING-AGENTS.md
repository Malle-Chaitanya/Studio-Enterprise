# Limitation: Editing Migrated Agents in Gemini Enterprise

**Summary:** Migrated agents **cannot be edited in Google's own Agent Builder /
Agent Designer UI** — that visual editor only opens agents *hand-built inside it*,
not agents created programmatically (which is what migration does). Editing is still
fully possible, but it happens **via the API** (which CloudFuze drives), not in Google's
console. How much redeployment that takes depends on the agent **type**.

All statements below are **empirically verified** against the live API (studio-enterprise-
migration, Gemini Enterprise Standard) — see "Evidence" at the end.

---

## 1. The core limitation (and why)

**You cannot open or edit a migrated agent in Google's Agent Designer / Agent Studio.**

Observed (proven):
- The per-agent ⋮ menu offers only **Preview / Delete** — no "Edit".
- **"Open in Agent Designer" fails** for API-created low-code agents.
- Code-deployed **ADK agents do not appear in Agent Studio's list at all** — they show
  only under **Deployments** (Agent Runtime), which has no visual flow editor.

**Why:** Google's visual designer is an *authoring* tool — it can only open agents that
were **created interactively inside it**. Any agent created **programmatically** (by our
migration, or by any API call) is not registered as a designer draft, so the designer
cannot load it. This is a **Google platform limitation**, not a gap in our tool, and
there is **no API to make a migrated agent designer-editable**.

---

## 2. What IS editable, and how (by agent type)

| Agent type | Edit in Google's UI? | Edit **metadata** (name/description) | Edit **behavior** (instruction/tools) | Mechanism |
|---|---|---|---|---|
| **Low-code** (`lowCodeAgentDefinition`) — the default | ❌ No | ✅ Yes, in place | ✅ **Yes, in place** | `agents.patch` (one API call, no redeploy) |
| **ADK / Agent Runtime** (`adkAgentDefinition`) — gallery agents | ❌ No | ✅ Yes, in place | ⚠️ Needs **redeploy** | metadata: `agents.patch`; behavior: `reasoningEngines.update` / redeploy |
| **Any type** — `state` (PRIVATE/ENABLED) | ❌ | ❌ **Immutable** | ❌ | none (server-controlled) |

### Low-code agents — fully editable via API, no redeploy
The instruction lives **inside the agent** (`lowCodeAgentDefinition.nodes[].llmAgentNode.
instruction`), so a single `agents.patch` updates name, description, instruction, tools,
and starter prompts **in place** — the change reflects in the console/gallery immediately.
**No redeploy, no delete-and-recreate.**

### ADK / deployed agents — behavior needs a redeploy
The agent's "brain" (instruction, tools, model) is **not** in the agent resource — it's
baked into the separately-deployed **Reasoning Engine** (the ADK Python code). Therefore:
- **Metadata** (displayName, description, which reasoning engine it points to) → editable
  via `agents.patch`.
- **Behavior** (the instruction itself) → requires **updating/redeploying the reasoning
  engine** (`agent_engines.update` in place, or redeploy + re-point). It **cannot** be
  changed with a simple `agents.patch`, because that field isn't on the agent resource.

This is *why* "we can't just edit the deployed agent": for the deployed (ADK) type, the
editable behavior lives in deployed compute, not in an editable config object.

---

## 3. How to edit anyway (the supported path)

Because Google's UI won't edit migrated agents, **editing is provided through CloudFuze**,
which calls the APIs under the hood. To the client it's a no-code form; there is no
code or console work.

- **Low-code agent** → CloudFuze "Edit Agent" screen → **`agents.patch`** → live instantly.
  *(Recommended default path; cheap, in place, no redeploy.)*
- **ADK / gallery agent** →
  1. metadata edits → `agents.patch`;
  2. behavior edits → CloudFuze regenerates the ADK spec from the edited instruction and
     **updates the reasoning engine** (`agent_engines.update`), then keeps the same
     registration. *(Heavier — involves a redeploy of the runtime.)*
- **`state`** → not editable by anyone (Google-controlled).

**Client-facing statement:**
> *"Edit your migrated agents in CloudFuze — no code. Google's own Agent Builder can't
> edit migrated agents (a Google limitation for any agent not hand-built in their
> designer). Changes you make in CloudFuze go live in Gemini automatically."*

---

## 4. Practical implication for the product

- **Default to low-code** → editing is a single in-place `agents.patch`; simplest for
  clients and for us.
- **ADK/gallery agents** are the only ones where "edit" costs a redeploy of the reasoning
  engine — factor this into the "publish to gallery" upgrade (cost + edit latency).
- **Build a no-code "Edit Agent" screen in CloudFuze** (form → `patchAgent()`), since
  Google's designer is not an option. This turns the limitation into a first-class feature
  owned by our product.

---

## 5. Evidence (live API tests)

- `agents.patch` **exists** (official): `PATCH …/agents/{id}?updateMask=…`, permission
  `discoveryengine.agents.update`. [ref](https://docs.cloud.google.com/generative-ai-app-builder/docs/reference/rest/v1alpha/projects.locations.collections.engines.assistants.agents/patch)
- `PATCH updateMask=displayName,description` → **200**, fields changed in place (verified).
- `PATCH updateMask=lowCodeAgentDefinition` (modified instruction) → **200**, instruction
  length changed 299→325 then reverted (verified — low-code behavior is patchable in place).
- `PATCH updateMask=state` → **400 "immutable path 'state'"** (verified — state locked).
- "Open in Agent Designer" / ⋮ = Preview+Delete only / ADK agents absent from Agent Studio
  (all observed in the console).

Diagnostics: `_diag_patch_agent.ts`, `_diag_patch_instruction.ts`, `_diag_publish_agent.ts`.

---

## 6. Future note
Gemini Enterprise is new (2026). Google may later allow editing migrated/programmatic
agents in their designer. If/when they do, it's a bonus — but **do not design around it**;
the supported path today is **edit-in-CloudFuze → API**. Companion: `GEMINI-CHATBOT-CLAIMS-
FACTCHECK.md` (state immutability), `MIGRATION-V1.md`.
