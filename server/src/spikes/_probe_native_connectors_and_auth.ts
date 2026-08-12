/**
 * Can we stop owning the Atlassian half of the pipeline?
 *
 * Two decisions hang on this probe, and both are currently guesses:
 *
 *  1. ACLs. Our crawl produces data stores with `aclEnabled: false`, which is IMMUTABLE —
 *     a SharePoint folder restricted to Finance becomes readable by anyone who can reach
 *     the migrated agent. Google's native Jira/Confluence connectors reportedly preserve
 *     per-user ACLs via an identity-mapping store. If true, native beats ours on the one
 *     axis we cannot ever win.
 *
 *  2. Actions. Gemini Enterprise exposes per-user write actions (create_jira_issue etc.)
 *     performed "on behalf of your end users". UNKNOWN whether a CUSTOM ADK agent can
 *     invoke them, or whether they are limited to the built-in assistant. If assistant-only,
 *     they do nothing for migrated agents and the native path only covers knowledge.
 *
 * Also checks whether `authorizations` (the end-user OAuth resource behind
 * `authorizationConfig.toolAuthorizations`) is reachable in this project at all — that is
 * the mechanism the per-user tool work depends on.
 *
 * NOTE ON SHAREPOINT: the native connector was rejected for SharePoint for a specific
 * reason that still stands — it needs a certificate-minted token (`appidacr: 2`) and
 * customers can only give us a client secret. That does NOT generalise to Atlassian,
 * which uses OAuth the customer can actually complete.
 *
 * Read-only. Lists and GETs only — creates nothing, deploys nothing, costs no quota.
 *
 * npx tsx src/spikes/_probe_native_connectors_and_auth.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';

const LOC = 'global';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ geminiProject: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.geminiProject) {
  console.error('No session with a geminiProject — connect Google through the UI once first.');
  process.exit(1);
}
const saToken = await getSaToken(s.gEmail);
const dest = await resolveDestination(s.geminiProject, saToken);
const project = dest.project;
const h = { Authorization: `Bearer ${saToken}` };

console.log(`\n═══ project ${project} · engine ${dest.engine} ═══\n`);

async function get(url: string): Promise<{ status: number; body: any }> {
  // Retry once: this endpoint family ECONNRESETs intermittently, and a transient socket
  // error reported as "the API does not support this" would send the whole decision the
  // wrong way.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: h });
      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 300);
      }
      return { status: res.status, body };
    } catch (err) {
      if (attempt >= 2) return { status: 0, body: `network: ${(err as Error).message}` };
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

function show(label: string, r: { status: number; body: any }, pick?: (b: any) => void) {
  const ok = r.status >= 200 && r.status < 300;
  console.log(`${ok ? '  ok ' : `  ${r.status} `} ${label}`);
  if (!ok) {
    const msg = r.body?.error?.message ?? (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    console.log(`       ${String(msg).slice(0, 220)}`);
    return;
  }
  if (pick) pick(r.body);
}

// ── 1. Authorizations — the end-user OAuth resource ──────────────────────────
// This is what `authorizationConfig.toolAuthorizations` points at. If we cannot even
// list them, the whole per-user tool plan is blocked on IAM before any code is written.
console.log('─── 1. authorizations (end-user OAuth) ───');
show(
  'list authorizations',
  await get(`${HOST}/projects/${project}/locations/${LOC}/authorizations`),
  (b) => {
    const list = b.authorizations ?? [];
    console.log(`       ${list.length} existing`);
    for (const a of list) console.log(`       • ${a.name?.split('/').pop()} (${a.serverSideOauth2?.tokenUri ?? '—'})`);
  },
);

// ── 2. Collections + data connectors — what is already ingested natively ─────
// A dataConnector on a collection IS a native connector. Its dataSource names the
// provider and `aclEnabled`/identity settings say whether ACLs survive ingestion.
console.log('\n─── 2. collections and native data connectors ───');
const cols = await get(`${HOST}/projects/${project}/locations/${LOC}/collections`);
show('list collections', cols, (b) => {
  const list = b.collections ?? [];
  console.log(`       ${list.length} collection(s)`);
  for (const c of list) console.log(`       • ${c.name?.split('/').pop()} — displayName=${c.displayName ?? '—'}`);
});
for (const c of cols.body?.collections ?? []) {
  const id = c.name?.split('/').pop();
  const dc = await get(`${HOST}/projects/${project}/locations/${LOC}/collections/${id}/dataConnector`);
  if (dc.status >= 200 && dc.status < 300) {
    const d = dc.body;
    console.log(`       ▸ ${id} dataConnector: dataSource=${d.dataSource ?? '—'} state=${d.state ?? '—'}`);
    console.log(`         identityRefreshInterval=${d.identityRefreshInterval ?? '—'} identityScheduleConfig=${JSON.stringify(d.identityScheduleConfig ?? null)}`);
    // The whole ACL question in one field.
    console.log(`         aclEnabled=${d.aclEnabled ?? '(unset)'} entities=${(d.entities ?? []).map((e: any) => e.entityName).join(', ') || '—'}`);
  }
}

// ── 3. Our own data stores — confirm what we produce today ───────────────────
// Establishes the baseline the native connector would be replacing.
console.log('\n─── 3. our data stores (aclEnabled baseline) ───');
show(
  'list dataStores',
  await get(`${HOST}/projects/${project}/locations/${LOC}/collections/default_collection/dataStores?pageSize=100`),
  (b) => {
    const list = b.dataStores ?? [];
    console.log(`       ${list.length} store(s)`);
    // Print every store: a truncated list cannot answer "how many of ours lose ACLs".
    for (const d of list) {
      console.log(`       • ${d.name?.split('/').pop()} acl=${d.aclEnabled ?? false} content=${d.contentConfig ?? '—'}`);
    }
  },
);

// ── 4. Assistant — are Actions attached, and are they assistant-only? ────────
// The decisive unknown. If actions live on the ASSISTANT and nothing exposes them to a
// registered agent, then native Actions cannot serve a migrated ADK agent at all and the
// native path covers knowledge only.
console.log('\n─── 4. assistant configuration (actions / tools) ───');
show(
  'get assistant',
  await get(
    `${HOST}/projects/${project}/locations/${LOC}/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`,
  ),
  (b) => {
    console.log(`       keys: ${Object.keys(b).join(', ')}`);
    for (const k of ['actionList', 'enabledActions', 'toolList', 'tools', 'webGroundingType', 'customerPolicy']) {
      if (b[k] !== undefined) console.log(`       ${k}: ${JSON.stringify(b[k]).slice(0, 400)}`);
    }
  },
);

// ── 5. Agents — what an existing registered agent is allowed to declare ──────
// authorizationConfig on a real agent is the proof that per-user auth is wired the way
// the docs describe, and shows the exact field name our registration must send.
console.log('\n─── 5. registered agents (authorizationConfig shape) ───');
show(
  'list agents',
  await get(
    `${HOST}/projects/${project}/locations/${LOC}/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents?pageSize=50`,
  ),
  (b) => {
    const list = b.agents ?? [];
    console.log(`       ${list.length} agent(s)`);
    for (const a of list.slice(0, 15)) {
      const auth = a.authorizationConfig ? JSON.stringify(a.authorizationConfig) : '—';
      console.log(`       • ${a.displayName} auth=${auth}`);
    }
  },
);

console.log('\n═══ How to read this ═══');
console.log('  §1 empty but 200      → mechanism available, nothing configured yet (expected)');
console.log('  §1 403                → per-user tool work is blocked on IAM, not on code');
console.log('  §2 aclEnabled=true    → native connector preserves ACLs; ours cannot. Real argument to switch');
console.log('  §3 acl=false          → confirms the baseline we are trying to beat');
console.log('  §4 actions present    → check whether any field ties them to an AGENT, not just the assistant');
console.log('  §5 authorizationConfig→ the exact field to send at registration for per-user tools\n');
process.exit(0);
