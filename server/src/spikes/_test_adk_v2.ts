/**
 * ADK Confluence agent v2 — everything in studio-enterprise-migration.
 *
 * Why v2: sonorous-lightning-t224x is Google-managed (No Organization).
 * Mia can't grant IAM there. Fix: data store + RE both in our SA project
 * (studio-enterprise-migration, #231705905417). We control IAM there, so
 * we can grant the RE service agent discoveryengine.viewer on our project.
 *
 * Architecture:
 *   mia's Gemini Business (sonorous-lightning-t224x)
 *     └── Agent "Confluence Knowledge Agent" [ENABLED] ← visible in UI
 *           └── RE in studio-enterprise-migration (#231705905417)
 *                 └── VertexAiSearchTool → DE data store in studio-enterprise-migration
 *                       └── IAM: service-231705905417@gcp-sa-aiplatform-re → discoveryengine.viewer ✓ (we grant this)
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_v2.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { createDataStore, importDocumentsFromGcs, awaitImport, dataStoreResourcePath } from '../services/geminiDataStore.js';
import { ensureBucket, uploadBytesToGcs, grantDeServiceAgentBucketAccessByNumber } from '../services/gcsUpload.js';
import { sanitizeDataStoreId } from '../services/knowledgePlanner.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';

// Customer project (Gemini Business — Google-managed, no IAM access)
const GCP_PROJECT    = 'sonorous-lightning-t224x';
const GEMINI_ADMIN   = 'mia@cloudfuze.com';

// Our SA project — we own this, full IAM control
const SA_PROJECT     = 'studio-enterprise-migration';
const SA_PROJ_NUM    = '231705905417';  // numeric ID for service agent email
const GCP_LOCATION   = 'us-central1';

const AGENT_NAME     = 'Confluence Knowledge Agent';
const AGENT_DESC     = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR)';
const DATA_STORE_ID  = sanitizeDataStoreId('cf-knowledge-eng-hr');
const GCS_BUCKET     = `${SA_PROJECT}-adk-staging`;

// Old agent to clean up (v1, grounding broken)
const OLD_AGENT_ID = '10977013538552887452';
// Old RE to clean up
const OLD_RE = 'projects/231705905417/locations/us-central1/reasoningEngines/7646814749379788800';

// Confluence creds
const CONFLUENCE_BASE = 'https://cf2020.atlassian.net';
const CONFLUENCE_AUTH = 'Basic ' + Buffer.from(`sujana.manapuram@cloudfuze.com:${process.env.CONFLUENCE_TOKEN ?? ''}`).toString('base64');
const CONFLUENCE_SPACES = ['ENG', 'HR'];

console.log('=== ADK Confluence Agent v2 (SA-project grounding) ===\n');

const saTokenOwn = await getSaToken();             // SA's own — IAM on our project
const saToken    = await getSaToken(GEMINI_ADMIN); // DWD as mia — Gemini registration
const dest       = await resolveDestination(GCP_PROJECT, saToken);
console.log(`Customer project: ${dest.project}, Engine: ${dest.engine}`);
console.log(`SA project:       ${SA_PROJECT} (#${SA_PROJ_NUM})\n`);

// ── Step 0: Clean up old agent + RE ──────────────────────────────────────────
console.log('[0/7] Cleaning up old agent and RE...');
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const assistantBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;
const delAgent = await fetch(`${assistantBase}/agents/${OLD_AGENT_ID}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${saToken}` },
});
console.log(`  Delete old agent: ${delAgent.status} ${delAgent.ok ? '✓' : '(may already be gone)'}`);

// Delete old RE via REST
const delRe = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${OLD_RE}`,
  { method: 'DELETE', headers: { Authorization: `Bearer ${saTokenOwn}` } },
);
console.log(`  Delete old RE:    ${delRe.status} ${delRe.ok ? '✓' : '(may already be gone)'}`);

// ── Step 1: Fetch Confluence pages ────────────────────────────────────────────
console.log('\n[1/7] Fetching Confluence pages...');
const pages: { title: string; space: string; html: string }[] = [];
for (const space of CONFLUENCE_SPACES) {
  const url = `${CONFLUENCE_BASE}/wiki/rest/api/space/${space}/content/page?limit=5&expand=body.view&status=current`;
  const res = await fetch(url, { headers: { Authorization: CONFLUENCE_AUTH, Accept: 'application/json' } });
  if (!res.ok) { console.log(`  ${space}: HTTP ${res.status}`); continue; }
  const data = await res.json() as { results?: Array<{ title: string; body?: { view?: { value?: string } } }> };
  for (const p of data.results ?? []) {
    const html = p.body?.view?.value ?? '';
    if (html.length > 100) { pages.push({ title: p.title, space, html }); console.log(`  ${space}: "${p.title}"`); }
  }
}
console.log(`  Total: ${pages.length} pages`);
if (pages.length === 0) { console.error('No pages — check creds'); process.exit(1); }

// ── Step 2: GCS bucket + data store in OUR project ───────────────────────────
console.log('\n[2/7] GCS bucket + data store in studio-enterprise-migration...');
const bucketReady = await ensureBucket(saTokenOwn, SA_PROJECT, GCS_BUCKET);
if (!bucketReady.ok) { console.error(`  Bucket failed: ${bucketReady.error}`); process.exit(1); }
console.log(`  Bucket: gs://${GCS_BUCKET} ✓`);

const ds = await createDataStore(SA_PROJECT, saTokenOwn, {
  dataStoreId: DATA_STORE_ID,
  displayName: 'Confluence Knowledge (ENG + HR)',
  kind: 'document',
});
console.log(`  Data store: ${DATA_STORE_ID} — ${ds.alreadyExists ? 'already exists' : ds.created ? 'created ✓' : `error: ${ds.error}`}`);
if (!ds.created && !ds.alreadyExists) { console.error('Data store failed'); process.exit(1); }

// ── Step 3: Upload pages to GCS ───────────────────────────────────────────────
console.log('\n[3/7] Uploading to GCS...');
const gcsUris: string[] = [];
for (const page of pages) {
  const filename = `${page.space}-${page.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)}.html`;
  const bytes = Buffer.from(page.html, 'utf8');
  const up = await uploadBytesToGcs(saTokenOwn, GCS_BUCKET, `confluence/v2/${filename}`, bytes, 'text/html');
  if (!up.ok) { console.log(`  WARN: "${page.title}" failed: ${up.error}`); continue; }
  gcsUris.push(up.gcsUri!);
  console.log(`  Uploaded: ${filename}`);
}
console.log(`  ${gcsUris.length}/${pages.length} uploaded`);

// ── Step 4: Import into our data store ───────────────────────────────────────
console.log('\n[4/7] Importing into studio-enterprise-migration data store...');

// Grant DE service agent of our project objectViewer on our bucket (idempotent)
await grantDeServiceAgentBucketAccessByNumber(saTokenOwn, SA_PROJ_NUM, GCS_BUCKET);

const imp = await importDocumentsFromGcs(SA_PROJECT, saTokenOwn, DATA_STORE_ID, gcsUris);
if (!imp.started || !imp.operationName) { console.error(`  Import failed: ${imp.error}`); process.exit(1); }
console.log(`  Import started: ${imp.operationName}`);
let recon = { succeeded: 0, failed: 0 };
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    recon = await awaitImport(saTokenOwn, imp.operationName, gcsUris.length, { maxPolls: 40, intervalMs: 12000 });
    break;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt < 5 && msg.includes('ENOTFOUND')) { console.log(`  Network error, retrying...`); await new Promise(r => setTimeout(r, 15000)); }
    else throw err;
  }
}
console.log(`  Import: ${recon.succeeded} succeeded, ${recon.failed} failed`);
if (recon.succeeded === 0) { console.error('  No docs indexed'); process.exit(1); }

const dsPath = dataStoreResourcePath(SA_PROJECT, DATA_STORE_ID);
console.log(`  Data store path: ${dsPath}`);

// ── Step 5: Grant RE service agent discoveryengine.viewer on OUR project ─────
console.log('\n[5/7] Granting RE service agent discoveryengine.viewer (our project)...');
// RE service agent email uses PROJECT NUMBER
const reServiceAgent = `service-${SA_PROJ_NUM}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
const role = 'roles/discoveryengine.viewer';

const getIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:getIamPolicy`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
  body: '{}',
});
if (!getIam.ok) {
  console.log(`  WARN: getIamPolicy ${getIam.status} — ${(await getIam.text()).slice(0, 100)}`);
} else {
  const policy = await getIam.json() as { bindings?: { role: string; members: string[] }[] };
  policy.bindings = policy.bindings ?? [];
  const member = `serviceAccount:${reServiceAgent}`;
  const binding = policy.bindings.find(b => b.role === role);
  if (binding?.members.includes(member)) {
    console.log(`  Already granted: ${reServiceAgent} → ${role}`);
  } else {
    if (binding) binding.members.push(member);
    else policy.bindings.push({ role, members: [member] });
    const setIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:setIamPolicy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy }),
    });
    if (setIam.ok) console.log(`  Granted: ${reServiceAgent} → ${role} ✓`);
    else console.log(`  WARN: setIamPolicy ${setIam.status} — ${(await setIam.text()).slice(0, 100)}`);
  }
}

// ── Step 6: Deploy RE pointing to our data store ─────────────────────────────
console.log('\n[6/7] Deploying RE (2-5 min)...');
const spec = {
  name: 'confluence_knowledge_v2',
  displayName: AGENT_NAME,
  description: AGENT_DESC,
  model: 'gemini-2.5-flash',
  instruction: [
    `You are ${AGENT_NAME}, an AI assistant for CloudFuze.`,
    'Answer questions using the Confluence knowledge base (Engineering and HR pages).',
    'Always cite the page title when referencing specific information.',
    'If the answer is not in the knowledge base, say so clearly.',
  ].join(' '),
  tools: [],
  groundingDataStores: [dsPath],
};

const dep = await deployReasoningEngine(SA_PROJECT, GCP_LOCATION, spec, {
  scriptPath: 'scripts/adk_deploy.py',
  stagingBucket: `gs://${GCS_BUCKET}`,
  timeoutMs: 15 * 60 * 1000,
});
if (!dep.ok || !dep.reasoningEngine) { console.error(`  Deploy failed: ${dep.error}`); process.exit(1); }
console.log(`  RE: ${dep.reasoningEngine} ✓`);

// ── Step 7: Register in mia's Gemini project → ENABLED ────────────────────────
console.log('\n[7/7] Registering agent in mia\'s Gemini...');
const reg = await registerAdkAgent(dest, saToken, {
  reasoningEngine: dep.reasoningEngine,
  displayName: AGENT_NAME,
  description: AGENT_DESC,
});
if (!reg.registered) { console.error(`  Register failed: ${reg.error}`); process.exit(1); }
console.log(`  Agent ID: ${reg.agentId}`);
console.log(`  State:    ${reg.state}`);

const shareRes = await fetch(`${assistantBase}/agents/${reg.agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`  Share ALL_USERS: ${shareRes.status} ${shareRes.ok ? '✓' : '✗'}`);

console.log('\n=== DONE ===');
console.log(`Agent "${AGENT_NAME}" — state=${reg.state}`);
console.log(`Agent ID: ${reg.agentId}`);
console.log(`Grounding data store: ${dsPath}`);
console.log(`RE service agent: ${reServiceAgent} has discoveryengine.viewer on ${SA_PROJECT}`);
console.log(`\nOpen https://business.gemini.google and ask "What is the leave policy?" to test.`);
