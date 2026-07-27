# Knowledge Sources Migration Playbook
### Copilot Studio → Gemini Enterprise

> **Purpose:** A brainstorming + reference playbook capturing *everything* we worked out about
> migrating knowledge sources — what's possible, what's not, what needs a human, what's built,
> and what still has to be written. Use this later when developing the approaches.
>
> **Everything here is written in plain English first, with the technical detail underneath.**
>
> **Rule for this doc (and the project):** honesty over overclaiming. Every claim is marked
> ✅ proven / ⚠️ needs verification / ❌ not possible, and proof links are at the bottom.

---

## 0. The one big idea (read this first)

When we "migrate a knowledge source", **we do NOT copy Microsoft's learned search index.**
Copilot has already read and indexed the content on the Microsoft side, but that index cannot
be carried into Google. Instead, for each knowledge source we **re-establish the source on the
Google side and let Google re-index it.**

So the real question for every source is always: *"How do we re-establish this one on Google —
copy it, point at it, reconnect it, or rebuild it as a tool?"*

---

## 1. Two honest truths that shape everything

**Truth 1 — "Works in all cases" is real ONLY as coverage, not as full automation.**
- ✅ We *can* guarantee: every source is handled and reaches a known outcome (nothing silently dropped).
- ❌ We *cannot* guarantee: every source migrates with zero human touch.

**Truth 2 — Some steps can never be automated (by design, not by our limits):**
- **OAuth / admin consent** for connecting to Microsoft (SharePoint, OneDrive, etc.) — a real admin must approve it once.
- **Encrypted / sensitivity-labelled files** — unreadable at the source; even Copilot can't read them.
- **Agent-level behaviours** (official-source flag, allow-ungrounded, web-search toggle) — no Gemini equivalent to put them in.

These three are the permanent "human or impossible" edges. Everything else can be automated.

---

## 2. Copilot Studio knowledge source types (what we're migrating FROM)

| Type | What it is | Example |
|---|---|---|
| **Documents (file upload)** | Files uploaded to the agent, stored in Dataverse | `Return-Policy.pdf`, `Handbook.docx` |
| **Public website** | A URL the agent searches via Bing (max 2 levels deep) | `www.contoso.com`, `fabrikam.com/engines/rotary` |
| **SharePoint (full connector)** | Live link to a SharePoint site/library + Lists | `contoso.sharepoint.com/sites/policies` |
| **SharePoint / OneDrive files & folders** | Specific files/folders, synced, copied into Dataverse | a `/Sales Playbooks/` folder |
| **Dataverse** | Structured tables queried with RAG | `Accounts`, `Cases` tables |
| **SharePoint Lists** | Tabular list data | an "Asset Inventory" list |
| **Enterprise connectors** | Confluence, ServiceNow, Salesforce, Zendesk knowledge bases | an "IT Support" Confluence space |

**Uploaded file limits (Copilot side):** 512 MB/file, 500 files/agent. Supported: Word, Excel,
PowerPoint, PDF, TXT/MD/LOG, HTML, CSV, XML, OpenDocument, EPUB, RTF, iWork, JSON, YAML, LaTeX.
**Not** allowed: images/video/audio/executables (images only inside a PDF), encrypted/labelled files.

> ⚠️ **Two different "SharePoint" entries exist in Copilot's Add-knowledge dialog** and they behave
> differently — must be routed separately:
> - **"Featured" SharePoint** = live connector (whole sites, Lists, real-time, permission-trimmed).
> - **"Upload file → SharePoint/OneDrive"** = copies files into Dataverse, syncs, gives page-level PDF citations.

---

## 3. Gemini Enterprise targets (what we're migrating TO)

Gemini Enterprise hierarchy: **Project → Location → Collection → Data Store → Documents**, and an
**App/Engine (the agent)** is linked to one or more Data Stores. Data lands as **Documents** inside a
**Data Store**, or as **files attached directly to the agent**.

Target kinds:
- **Document data store** (unstructured files, backed by Google Cloud Storage / GCS)
- **Website data store** (crawled URLs) — ⚠️ see the big limitation in §4
- **Structured data store** (tabular, backed by BigQuery / inline records)
- **Native connectors** — SharePoint Online, OneDrive, Confluence, Jira, ServiceNow, Salesforce, Slack, Box, +80 more
- **Agent files** (files attached straight onto the agent — this is what our code uses today)

---

## 4. ⭐ THE CRITICAL FINDINGS (with proof)

### 4.1 Website data stores CANNOT connect to a Gemini Enterprise agent ❌ (proven)

> **"You can't connect website data stores to your Gemini Enterprise search and assistant apps."**
> — Google, *About apps and data stores* (verified twice; no exceptions listed)

**Plain English:** You can build a website container and load the URLs, but Gemini refuses to link it
to the agent. The agent has no path to it, so it never uses the website data. This is exactly why, after
migrating, a public website **did not appear in the destination UI** as usable knowledge.

**Workaround we used:** append the website URLs into the agent's **instructions** text.
- ✅ Keeps the reference.
- ⚠️ It is NOT grounded search — the agent just *sees the URLs written down*; it can't truly search them like Copilot did with Bing.

> ⚠️ **Conflict to resolve during development:** Our own code (`geminiDataStore.ts`) *does* create an
> **advanced** website data store and attach it to an **engine** (`createAdvancedSiteSearch=true`), with a
> comment "Engines only link ADVANCED website data stores." This suggests the Vertex AI Search *engine*
> surface may allow advanced website stores even though the *Gemini Enterprise assistant app* surface does
> not. **Action:** confirm exactly which destination surface we target (Vertex AI Search engine vs Gemini
> Enterprise assistant app) — the website answer differs between them. Also: advanced website indexing needs
> **Google Search Console domain verification**, and empirically an unverified domain → `indexingStatus=FAILED`, 0 docs.

### 4.2 SharePoint & OneDrive CAN connect ✅ (proven)

> "The Microsoft SharePoint data store for Gemini Enterprise lets you search and perform actions on your
> Microsoft SharePoint Online data, including **documents, lists, and sites**." — Google setup docs

**Plain English:** Unlike websites, SharePoint/OneDrive have working connectors that DO attach to the agent,
and the agent DOES use them. There is no locked door here.

- ✅ Can scope to specific **sites**, **paths**, **folders**, **document libraries** (include/exclude filters).
- ✅ Supports **incremental / scheduled sync** to stay current.
- ✅ Covers documents, folders, AND Lists in one connector.
- ⚠️ Requires a one-time **OAuth app registration in Microsoft Entra ID** (Client ID, Secret, Tenant ID, Instance URI) + permissions — the human gate.
- ⚠️ Per-user permission trimming works only after **Workforce Identity Federation** (Entra→Google identity mapping) is set up. Skipping it over-exposes documents.

### 4.3 Two "ways" to bring SharePoint/OneDrive content in

| | **Way A — Federated ("peek live")** | **Way B — Ingestion ("copy over")** |
|---|---|---|
| Plain meaning | Leave files in Microsoft; Google peeks live per query | Copy files into Google |
| Data location | Stays in Microsoft | Copy lives in Google |
| Freshness | Instant (real-time API) | Only when it re-syncs |
| Search quality | Weaker on complex PDFs (tables/scans/OCR) | ✅ Better; Google recommends for complex PDFs |
| Survives customer leaving Microsoft? | ❌ No | ✅ Yes |
| Needs one-time admin OAuth? | Yes | Yes |
| No data copy? | ✅ Yes | ❌ No (it copies) |

> **Key insight:** Choosing Way B does **NOT** remove the human OAuth step — both ways need it. The A-vs-B
> choice is about *result* (live-and-external vs copied-into-Google), not about automation.

---

## 5. What form does content land in? (the "is it a PDF?" question)

**Files keep their own type — nothing is force-converted to PDF.** A PDF stays a PDF, a Word doc stays Word, etc.

Two parts happen to each file:
1. **The file itself** is stored in Google in its original form.
2. **Google reads the text inside it** and builds a searchable index (like a book's back-index).

The agent answers from the **extracted text**, and points back to the **original file** as the source/citation.

- ✅ Gemini/Vertex supported ingest formats: TXT, JSON, MD, PDF, HTML, DOCX, PPTX, XLSX, XLSM. Limits: **200 MB/file, 100k files/import.**
- ⚠️ Scanned-image PDFs / very complex PDFs (multi-column, big tables) don't always get clean text — a reason to prefer Way B (ingestion) which does deeper parsing.

---

## 6. Per-source migration matrix (the routing table)

| Copilot source | Strategy | Gemini target | Auto? | Terminal state | Key caveat |
|---|---|---|---|---|---|
| Uploaded document/PDF | copy-and-index | document data store / agent files | ✅ | Migrated | Must pass format+size gate; skip incompatible |
| Public website | recreate / append-to-instructions | website data store *(see §4.1)* | ❌ | Migrated w/ caveats | Can't attach to assistant app; needs domain verify for indexing |
| SharePoint (site/library) | reconnect | SharePoint connector | ❌ (1 OAuth) | Migrated after setup | Needs Entra OAuth + identity federation |
| OneDrive files/folders | reconnect | OneDrive connector | ❌ (1 OAuth) | Migrated after setup | Same identity federation need |
| SharePoint/OneDrive files (copy mode) | copy-and-index (Way B) | document data store | ❌ (1 OAuth) | Migrated after setup | Copies bytes; carry permissions separately |
| Dataverse table (reference/catalog) | dataverse-snapshot | structured data store (BigQuery/inline) | ✅ | Migrated | Snapshot = point-in-time; refresh on schedule |
| Dataverse table (sensitive/transactional) | rebuild-as-tool | agent tool | ❌ | Manual | Snapshot would flatten row-level security |
| SharePoint Lists | dataverse-snapshot-style export | structured data store | ⚠️ | Migrated w/ caveats | Tabular, NOT a file copy |
| Confluence / ServiceNow / Salesforce | reconnect | matching connector | ❌ (1 OAuth) | Migrated after setup | Zendesk connector on Gemini = ⚠️ verify |
| Azure Blob | copy-and-index | GCS import | ❌ | Manual | Needs blob credentials |
| SQL / database | rebuild-as-tool | agent tool | ❌ | Manual | A DB can't be "indexed" as knowledge |
| Azure AI Search index | manual-review | none | ❌ | Manual | Prebuilt index can't be moved; re-point at source docs |
| Custom API / Graph / MCP | rebuild-as-tool | agent tool | ❌ | Manual | Recreate tool + auth + schema on Google side |
| Unrecognized kind | manual-review | none | ❌ | Reported | Raw config preserved; never assumed migratable |

**Four terminal states (coverage guarantee — every source hits exactly one):**
1. ✅ Migrated (auto)
2. 🔓 Migrated (after 1 OAuth / setup)
3. ⚠️ Migrated with caveats (fidelity noted)
4. 📋 Reported (not migratable — surfaced with reason + manual guidance)

---

## 7. Current implementation status (as of this playbook — from the code)

> This is where the tool stands TODAY. Use it to know what to build next.

**✅ Built AND wired (runs in a real migration):**
- **Uploaded files / PDFs → attached directly onto the Gemini agent** (`attachKnowledgeFiles` → `uploadAgentFile` → `updateAgentFiles`, before publish). Idempotent (skips already-attached by filename), skips incompatible, counts failures. **Uploaded PDFs DO appear in the destination.**

**🟡 Built as functions but NOT wired into the live flow (only used in a diagnostic):**
- Document **data store** path: `createDataStore('document')` + `importDocumentsFromGcs` (GCS → ImportDocuments, `dataSchema: 'content'`, `reconciliationMode: 'INCREMENTAL'`).
- **Website** data store path: `createDataStore('website', createAdvancedSiteSearch=true)` + `addTargetSite` + `attachDataStoreToEngine` (exercised only in `_diag_website.ts`).
- **Structured** path: `importStructuredInline` (inline `structData`, capped 100 docs/request → must chunk).
- The orchestrator explicitly logs for non-file sources: *"data-store path not yet wired."*

**❌ NOT built at all (only planned as manual checklists):**
- SharePoint connector creation (no executor).
- OneDrive connector creation (no executor).
- Any live-connector (Confluence/ServiceNow/etc.) executor.
- Dataverse snapshot execution end-to-end (classifier + planner decide it; executor not wired).

**Classifier facts (`knowledgeClassifier.ts`):**
- Rule order matters: uploaded-file rule runs BEFORE SharePoint (so "upload files > SharePoint" = copy, not reconnect).
- SharePoint & OneDrive → `strategy: 'reconnect'`, `automatable: false` (correct cautious call — needs identity federation).
- Website → `automatable: false`; ownership (owned / third-party / unknown) drives the *recommendation*.
- Falls back to inferring strategy from the reference URL when the `kind` token is unknown; truly unknown → `manual-review`.

---

## 8. Build options for SharePoint/OneDrive (what to write later)

### Option 1 — Use Google's native connector
Write code that creates a SharePoint/OneDrive **DataConnector**, points it at the same sites/folders,
and picks Way A (federated) or Way B (ingestion). Google manages the sync.
- Pros: less code; Google handles sync + ACL trimming (once federation is set).
- Cons: bound by connector behaviour; still needs OAuth + identity federation.

### Option 2 — Copy the files ourselves (the CloudFuze way) ⭐ recommended
Write code that: (1) pulls files out of SharePoint/OneDrive → (2) drops them in GCS → (3) `ImportDocuments`
into a document data store (or attaches to the agent, like we already do for uploaded files).
- Pros: **reuses code we already have** for uploaded files; plays to CloudFuze's content-migration strength;
  files truly land in Google so they survive the customer leaving Microsoft.
- Cons: it's a copy (storage + can go stale); **must also migrate permissions** (who can see what) separately.
- Feasibility: ✅ definitely buildable — it's the uploaded-file path with a SharePoint source instead of Dataverse.

**Recommendation:** default to **Option 2** for a migration product; offer Option 1 (federated) when the
customer is keeping Microsoft and wants always-live, no-duplication.

---

## 9. Feasibility summary — possible / not / needs human

| Capability | Verdict |
|---|---|
| Migrate uploaded documents/PDFs automatically | ✅ Possible (already works) |
| Copy SharePoint/OneDrive files into Google (Way B) | ✅ Possible to build |
| Reconnect SharePoint/OneDrive live (Way A) | ✅ Possible to build |
| Migrate Dataverse tables (reference) as structured snapshot | ✅ Possible |
| Attach a **website** data store to a Gemini **assistant** app | ❌ Not possible (Google blocks it) — use instructions workaround / verify engine surface |
| Fully automatic, zero-human, for connectors | ❌ Not possible (OAuth needs an admin) |
| Migrate encrypted / sensitivity-labelled files | ❌ Not possible (unreadable) |
| Migrate agent-level knowledge behaviours (official-source, etc.) | ❌ Not possible (no Gemini equivalent) → report |
| Preserve per-user permission trimming | 🔓 Needs humans — requires identity federation setup |
| Guarantee 100% coverage (every source → a known outcome) | ✅ Possible (4-state classifier) |

---

## 10. The unavoidable human steps (front-load these into a pre-flight)

1. **GCP project + IAM** (service account, Discovery Engine Editor role) — one-time.
2. **OAuth app registration in Microsoft Entra ID** per connector — one-time, batch them all up front.
3. **Workforce Identity Federation** (Entra→Google) if per-user permission trimming is required.
4. **Google Search Console domain verification** if using an (owned-domain) website data store.
5. **Human confirmation** that a Dataverse table has no protected/PII rows before snapshotting.

Design them as a **pre-flight readiness step** so the migration itself feels hands-off after approval,
and make the pipeline **resumable** (a source waiting on OAuth pauses, doesn't fail).

---

## 11. Proof / sources (verified against live Google + Microsoft docs)

- Copilot knowledge sources summary — https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-copilot-studio
- Copilot file upload types — https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-file-upload
- Copilot public website rules — https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-public-website
- Copilot SharePoint source — https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-sharepoint
- Copilot unstructured data (OneDrive/SP files, connectors) — https://learn.microsoft.com/en-us/microsoft-copilot-studio/knowledge-add-unstructured-data
- **Gemini: website data stores can't connect to apps** — https://docs.cloud.google.com/gemini/enterprise/docs/apps-data-stores
- Gemini connectors intro — https://docs.cloud.google.com/gemini/enterprise/docs/connectors/introduction-to-connectors-and-data-stores
- Gemini SharePoint connector setup — https://docs.cloud.google.com/gemini/enterprise/docs/connectors/ms-sharepoint/set-up-data-store
- Gemini SharePoint federation — https://docs.cloud.google.com/gemini/enterprise/docs/connect-sharepoint-online
- Gemini OneDrive connector — https://docs.cloud.google.com/gemini/enterprise/docs/connectors/ms-onedrive
- Vertex AI Search website domain verification — https://cloud.google.com/generative-ai-app-builder/docs/domain-verification

---

## 12. Open items to verify before building (don't assume)

- [ ] **Website surface conflict (§4.1):** Vertex AI Search engine vs Gemini Enterprise assistant app — does advanced website data store attach on our actual target?
- [ ] **Zendesk** connector on the Gemini side — confirm it exists.
- [ ] **Web Grounding for Enterprise** — can it be scoped to a specific allow-list of domains (to match Copilot's Bing-scoped behaviour)?
- [ ] Exact **permission-mapping** path when copying files (SharePoint ACL → Google Drive/GCS IAM).
- [ ] Whether the **document data-store path** should replace the current **agent-files** path for uploaded files, or coexist.
