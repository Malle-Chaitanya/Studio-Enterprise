# ADK file-grounding — required permissions

What CloudFuze's service account (SA) needs to ground an ADK-deployed agent on a locally-uploaded
knowledge file, end to end. Written 2026-08-03 after live-verifying the mechanism (see
[.claude/memory/decisions.md](../.claude/memory/decisions.md)).

## Summary table

| Permission / role | Why | Already covered by this tool's existing access? |
|---|---|---|
| `roles/discoveryengine.editor` (or equivalent create/import rights on Discovery Engine) | Create the "document" data store, import the uploaded file into it | **Yes** — already required for everything else this tool does in Gemini (agents, engines, existing website/table data stores) |
| Storage Object write access on the ADK staging bucket (`{project}-adk-staging`) | Upload the file's bytes to GCS before `documents:import` can read them | **Yes** — the SA already needs bucket read/write for ADK's own code-packaging step; `cloud-platform` scope covers it |
| **`resourcemanager.projects.getIamPolicy` + `setIamPolicy`** on the customer's project | Grant the Reasoning Engine's own runtime service agent read access to Discovery Engine, so the deployed agent can actually query the data store at inference time | **No — this is new and more privileged than anything else this product asks for today** |

## The one new, sensitive permission

**Role needed:** `roles/discoveryengine.viewer` (or narrower, see below)
**Granted to:** `service-{PROJECT_NUMBER}@gcp-sa-aiplatform-re.iam.gserviceaccount.com` — a **Google-managed** service agent for Vertex AI Reasoning Engine, not one CloudFuze controls.
**Why:** the SA that creates the data store and the identity that actually *executes* a deployed Reasoning Engine agent are different. Confirmed live: without this grant, every query to an otherwise-correctly-configured `VertexAiSearchTool` returns:

```
403 PERMISSION_DENIED: Permission 'discoveryengine.servingConfigs.search' denied
on resource '.../dataStores/{id}/servingConfigs/default_search'
```

**To grant it manually** (as the customer's Google Cloud project owner/IAM admin):

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:service-PROJECT_NUMBER@gcp-sa-aiplatform-re.iam.gserviceaccount.com" \
  --role="roles/discoveryengine.viewer"
```

**For CloudFuze's SA to grant it automatically instead**, the SA itself needs `resourcemanager.projects.setIamPolicy` on the customer's project — e.g. `roles/resourcemanager.projectIamAdmin`, or being a project Owner/Editor. **This is a materially bigger ask than the tool's normal access model** (a scoped Direct IAM grant of specific Discovery Engine/Vertex AI roles, or Domain-Wide Delegation impersonating the connected admin) — granting IAM-policy-editing rights on a whole project is a broader blast radius, and most customers' security teams will (reasonably) balk at it.

## Two ways to ship this for real customers

1. **Manual one-time admin step (recommended default for enterprise customers):** during Gemini destination setup, if the customer wants ADK file grounding, ask their Google admin to run the `gcloud` command above once per project — same category of ask as the existing Direct IAM/DWD connection dance this product already requires.
2. **Automatic grant by CloudFuze's SA**: only viable if the SA already has (or the customer grants) `resourcemanager.projects.setIamPolicy`. Not recommended as the default — this is a much broader permission than Discovery Engine access alone.

## Resolved: no narrower alternative exists

Checked live (2026-08-03): `POST {dataStoreResourceName}:getIamPolicy` against a real data store returns `404 Method not found`. **Discovery Engine data stores have no resource-level IAM policy at all** — access is controlled ONLY via project- (or folder-/org-) level Cloud IAM. There is no way to scope the grant down to "just this one data store." The choice is genuinely binary between option 1 and option 2 above — this is now settled, not an open question.

This actually makes option 1 an easier sell than it might first sound: the grant is `roles/discoveryengine.viewer` (**read-only**), given to a **Google-managed** service agent (not CloudFuze, not any third party) so that one Google product (Reasoning Engine) can read another Google product's data (Discovery Engine) *within the customer's own project*. That's a standard, common GCP pattern — closer to "enabling an integration between two Google services" than "handing an external vendor the keys." The genuinely risky ask is option 2 (CloudFuze's own SA getting project-wide IAM-editing rights), not option 1.

## What does NOT need any new permission

- Creating the document data store, uploading to GCS, importing, and indexing — all covered by the SA's existing Discovery Engine + Storage access (same access already used for the website-grounding path and the Dataverse-snapshot structured data stores).
- The multi-store `data_store_specs` combination (website + file sources together) needs no extra permission beyond the above — it's a request-shape difference, not an access difference. (That combination itself is separately flagged as not-yet-live-tested in the decision log — a functional risk, not a permissions one.)
