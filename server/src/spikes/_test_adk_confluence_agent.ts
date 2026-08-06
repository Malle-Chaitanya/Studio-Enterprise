/**
 * Create a FULLY ENABLED Confluence Knowledge Agent via the ADK path.
 *
 * ADK agents are created state=ENABLED automatically (no widget API browser
 * session needed). This is the production solution for Business-edition Gemini
 * Enterprise — low-code agents via standard API are always PRIVATE and cannot
 * serve queries (proven exhaustively; see adkDeployer.ts comments).
 *
 * What this does:
 *   1. Fetch Confluence pages (ENG + HR + SAL spaces, up to 5 each)
 *   2. Create ONE Discovery Engine document data store for all pages
 *   3. Upload pages to GCS, import into the data store
 *   4. Deploy an ADK Reasoning Engine with VertexAiSearchTool (adk_deploy.py)
 *   5. registerAdkAgent → state=ENABLED automatically
 *   6. Share to ALL_USERS
 *
 * Prereqs: pip install "google-cloud-aiplatform[agent_engines,adk]" google-adk
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_confluence_agent.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { createDataStore, importDocumentsFromGcs, awaitImport, dataStoreResourcePath } from '../services/geminiDataStore.js';
import { ensureBucket, uploadBytesToGcs, grantDeServiceAgentBucketAccessByNumber } from '../services/gcsUpload.js';
import { sanitizeDataStoreId } from '../services/knowledgePlanner.js';
import { deployReasoningEngine, registerAdkAgent, ensureReasoningEngineDiscoveryAccess } from '../services/adkDeployer.js';

const GCP_PROJECT    = 'sonorous-lightning-t224x';
// Numeric project number for sonorous-lightning-t224x (for DE service agent grant)
const GCP_PROJECT_NUMBER = '521161651560';
const GCP_LOCATION   = 'us-central1';
const GEMINI_ADMIN   = 'mia@cloudfuze.com';
const AGENT_NAME     = 'Confluence Knowledge Agent';
const AGENT_DESC     = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR, Sales)';
const DATA_STORE_ID  = sanitizeDataStoreId('confluence-knowledge-agent-all');
// GCS bucket lives in our SA project — mia doesn't have Storage Admin on customer project
const SA_PROJECT     = 'studio-enterprise-migration';
const GCS_BUCKET     = `${SA_PROJECT}-adk-staging`;

// Confluence creds (in production: load from Secret Manager)
const CONFLUENCE_BASE = 'https://cf2020.atlassian.net';
const CONFLUENCE_AUTH = 'Basic ' + Buffer.from(`sujana.manapuram@cloudfuze.com:${process.env.CONFLUENCE_TOKEN ?? ''}`).toString('base64');
const CONFLUENCE_SPACES = ['ENG', 'HR', 'SAL'];

console.log('=== ADK Confluence Knowledge Agent ===\n');

// Two tokens: SA's own (for GCS) vs DWD-as-mia (for DE in customer project)
const saTokenOwn = await getSaToken();            // SA's own identity — Storage Admin on our project
const saToken    = await getSaToken(GEMINI_ADMIN); // DWD as mia — Discovery Engine ops in customer project
const dest       = await resolveDestination(GCP_PROJECT, saToken);
console.log(`Project: ${dest.project}, Engine: ${dest.engine}`);

// ── Step 1: Fetch Confluence pages ────────────────────────────────────────────
console.log('\n[1/6] Fetching Confluence pages...');
const pages: { title: string; space: string; html: string }[] = [];

for (const space of CONFLUENCE_SPACES) {
  const url = `${CONFLUENCE_BASE}/wiki/rest/api/space/${space}/content/page?limit=5&expand=body.view&status=current`;
  const res = await fetch(url, { headers: { Authorization: CONFLUENCE_AUTH, Accept: 'application/json' } });
  if (!res.ok) {
    console.log(`  ${space}: HTTP ${res.status}`);
    continue;
  }
  const data = await res.json() as { results?: Array<{ id: string; title: string; body?: { view?: { value?: string } } }> };
  for (const p of data.results ?? []) {
    const html = p.body?.view?.value ?? '';
    if (html.length > 100) {
      pages.push({ title: p.title, space, html });
      console.log(`  ${space}: "${p.title}" (${html.length} chars)`);
    }
  }
}
console.log(`  Total: ${pages.length} pages`);

if (pages.length === 0) {
  console.error('No pages fetched — check Confluence credentials');
  process.exit(1);
}

// ── Step 2: Ensure GCS bucket + data store ────────────────────────────────────
console.log('\n[2/6] Setting up GCS bucket + data store...');

// Use SA's own token (Storage Admin on our project) — DWD token (mia) lacks GCS perms
const bucketReady = await ensureBucket(saTokenOwn, SA_PROJECT, GCS_BUCKET);
if (!bucketReady.ok) {
  console.error(`  Bucket setup failed: ${bucketReady.error}`);
  process.exit(1);
}
// Grant customer project's DE service agent objectViewer on our bucket
await grantDeServiceAgentBucketAccessByNumber(saTokenOwn, GCP_PROJECT_NUMBER, GCS_BUCKET);
console.log(`  Bucket: gs://${GCS_BUCKET} ✓ (DE service agent granted objectViewer)`);

const ds = await createDataStore(GCP_PROJECT, saToken, {
  dataStoreId: DATA_STORE_ID,
  displayName: 'Confluence Knowledge (all spaces)',
  kind: 'document',
});
console.log(`  Data store: ${DATA_STORE_ID} — ${ds.alreadyExists ? 'already exists' : ds.created ? 'created' : `error: ${ds.error}`}`);
if (!ds.created && !ds.alreadyExists) {
  console.error('Data store creation failed');
  process.exit(1);
}

// ── Step 3: Upload pages to GCS ───────────────────────────────────────────────
console.log('\n[3/6] Uploading pages to GCS...');
const gcsUris: string[] = [];
for (const page of pages) {
  const filename = `${page.space}-${page.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)}.html`;
  const bytes = Buffer.from(page.html, 'utf8');
  const objName = `confluence/${DATA_STORE_ID}/${filename}`;
  const up = await uploadBytesToGcs(saTokenOwn, GCS_BUCKET, objName, bytes, 'text/html');
  if (!up.ok) {
    console.log(`  WARN: upload failed for "${page.title}": ${up.error}`);
    continue;
  }
  gcsUris.push(up.gcsUri!);
  console.log(`  Uploaded: ${filename}`);
}
console.log(`  ${gcsUris.length}/${pages.length} files uploaded`);

// ── Step 4: Import into data store ────────────────────────────────────────────
console.log('\n[4/6] Importing documents into data store...');
const imp = await importDocumentsFromGcs(GCP_PROJECT, saToken, DATA_STORE_ID, gcsUris);
if (!imp.started || !imp.operationName) {
  console.error(`  Import failed: ${imp.error}`);
  process.exit(1);
}
console.log(`  Import started: ${imp.operationName}`);
console.log('  Waiting for import to complete (may take 1-5 min)...');
const recon = await awaitImport(saToken, imp.operationName, gcsUris.length, { maxPolls: 60, intervalMs: 10000 });
console.log(`  Import done: ${recon.succeeded} succeeded, ${recon.failed} failed`);
if (recon.succeeded === 0) {
  console.error('  No documents indexed — check data store');
  process.exit(1);
}

const dsResourcePath = dataStoreResourcePath(GCP_PROJECT, DATA_STORE_ID);
console.log(`  Data store path: ${dsResourcePath}`);

// ── Step 5: Grant Reasoning Engine Discovery Engine access (best-effort) ───────
console.log('\n[5/6] Granting Reasoning Engine → Discovery Engine access...');
const iam = await ensureReasoningEngineDiscoveryAccess(GCP_PROJECT, saToken);
if (iam.ok) {
  console.log(`  IAM grant: ${iam.alreadyGranted ? 'already granted' : 'granted ✓'}`);
} else {
  console.log(`  WARN: IAM grant failed (${iam.error}) — may 403 at query time`);
}

// ── Step 6: Deploy ADK Reasoning Engine ──────────────────────────────────────
console.log('\n[6/7] Deploying ADK Reasoning Engine (2-5 min)...');
const spec = {
  name: 'confluence_knowledge_agent',
  displayName: AGENT_NAME,
  description: AGENT_DESC,
  model: 'gemini-2.5-flash',
  instruction: [
    `You are ${AGENT_NAME}, an AI assistant for the CloudFuze team.`,
    `Answer questions using the Confluence knowledge base (Engineering, HR, and Sales pages).`,
    `Always cite the page title when referencing specific information.`,
    `If the information is not available, say so clearly rather than guessing.`,
  ].join(' '),
  tools: [],
  groundingDataStores: [dsResourcePath],
};

const dep = await deployReasoningEngine(GCP_PROJECT, GCP_LOCATION, spec, {
  scriptPath: 'scripts/adk_deploy.py',
  timeoutMs: 10 * 60 * 1000, // 10 min
});
if (!dep.ok || !dep.reasoningEngine) {
  console.error(`  Deploy failed: ${dep.error}`);
  process.exit(1);
}
console.log(`  Reasoning Engine: ${dep.reasoningEngine} ✓`);

// ── Step 7: Register ADK agent (ENABLED automatically) ────────────────────────
console.log('\n[7/7] Registering agent (ENABLED)...');
const reg = await registerAdkAgent(dest, saToken, {
  reasoningEngine: dep.reasoningEngine,
  displayName: AGENT_NAME,
  description: AGENT_DESC,
});
if (!reg.registered) {
  console.error(`  Register failed: ${reg.error}`);
  process.exit(1);
}
console.log(`  Agent ID: ${reg.agentId}`);
console.log(`  State:    ${reg.state}`);

// Share to ALL_USERS
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const assistantBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;
const shareRes = await fetch(
  `${assistantBase}/agents/${reg.agentId}?updateMask=sharingConfig`,
  {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
  },
);
console.log(`  Share ALL_USERS: ${shareRes.status} ${shareRes.ok ? '✓' : '✗'}`);

console.log('\n=== DONE ===');
console.log(`Agent "${AGENT_NAME}" created with state=${reg.state}`);
console.log(`Agent ID: ${reg.agentId}`);
console.log(`Open: https://business.gemini.google to verify`);
