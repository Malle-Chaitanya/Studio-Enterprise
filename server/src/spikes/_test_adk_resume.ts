/**
 * Resume from where _test_adk_confluence_agent.ts left off.
 *
 * Already done:
 *   - Data store "confluence-knowledge-agent-all" created in sonorous-lightning-t224x
 *   - 10 HTML pages uploaded to gs://studio-enterprise-migration-adk-staging/confluence/...
 *   - Import operation started (may or may not have completed yet)
 *
 * This spike:
 *   1. Polls the import operation until done
 *   2. Grants RE → DE IAM
 *   3. Deploys ADK Reasoning Engine
 *   4. registerAdkAgent → state=ENABLED
 *   5. Shares to ALL_USERS
 *
 * Usage: cd server && npx tsx src/spikes/_test_adk_resume.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { awaitImport, dataStoreResourcePath } from '../services/geminiDataStore.js';
import { deployReasoningEngine, registerAdkAgent, ensureReasoningEngineDiscoveryAccess } from '../services/adkDeployer.js';

const GCP_PROJECT      = 'sonorous-lightning-t224x';
const SA_PROJECT       = 'studio-enterprise-migration';
const GCP_LOCATION     = 'us-central1';
const GEMINI_ADMIN     = 'mia@cloudfuze.com';
const AGENT_NAME       = 'Confluence Knowledge Agent';
const AGENT_DESC       = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR, Sales)';
const DATA_STORE_ID    = 'confluence-knowledge-agent-all';
const GCS_BUCKET       = `${SA_PROJECT}-adk-staging`;
const IMPORT_OPERATION = 'projects/521161651560/locations/global/collections/default_collection/dataStores/confluence-knowledge-agent-all/branches/0/operations/import-documents-15193734559404654281';

console.log('=== ADK Resume (steps 5-7) ===\n');

const saTokenOwn = await getSaToken();
const saToken    = await getSaToken(GEMINI_ADMIN);
const dest       = await resolveDestination(GCP_PROJECT, saToken);
console.log(`Project: ${dest.project}, Engine: ${dest.engine}`);

// ── Step 1: Poll import operation ─────────────────────────────────────────────
console.log('\n[1/4] Checking import operation status...');
let importOk = false;
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    const recon = await awaitImport(saToken, IMPORT_OPERATION, 10, { maxPolls: 30, intervalMs: 15000 });
    console.log(`  Import done: ${recon.succeeded} succeeded, ${recon.failed} failed`);
    if (recon.succeeded > 0) importOk = true;
    break;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  Attempt ${attempt} failed: ${msg.slice(0, 80)}`);
    if (attempt < 5) {
      console.log('  Retrying in 20s...');
      await new Promise(r => setTimeout(r, 20000));
    }
  }
}
if (!importOk) {
  console.log('  WARN: Could not confirm import. Continuing anyway — import may have completed.');
}

const dsResourcePath = dataStoreResourcePath(GCP_PROJECT, DATA_STORE_ID);
console.log(`  Data store: ${dsResourcePath}`);

// ── Step 2: Grant Reasoning Engine → Discovery Engine access ──────────────────
// Use SA's own token (not DWD) — mia lacks resourcemanager.projects.getIamPolicy
console.log('\n[2/4] Granting RE → DE access...');
const iam = await ensureReasoningEngineDiscoveryAccess(GCP_PROJECT, saTokenOwn);
if (iam.ok) {
  console.log(`  IAM: ${iam.alreadyGranted ? 'already granted' : 'granted ✓'}`);
} else {
  console.log(`  WARN: IAM grant failed (${iam.error})`);
}

// ── Step 3: Deploy ADK Reasoning Engine ──────────────────────────────────────
console.log('\n[3/4] Deploying ADK Reasoning Engine (2-5 min)...');
const spec = {
  name: 'confluence_knowledge_agent',
  displayName: AGENT_NAME,
  description: AGENT_DESC,
  model: 'gemini-2.5-flash',
  instruction: [
    `You are ${AGENT_NAME}, an AI assistant for the CloudFuze team.`,
    'Answer questions using the Confluence knowledge base (Engineering and HR pages).',
    'Always cite the page title when referencing specific information.',
    'If the information is not available, say so clearly rather than guessing.',
  ].join(' '),
  tools: [],
  groundingDataStores: [dsResourcePath],
};

// Deploy RE in our SA project — SA has Vertex AI + Storage Admin there.
// registerAdkAgent accepts a cross-project RE resource path.
const dep = await deployReasoningEngine(SA_PROJECT, GCP_LOCATION, spec, {
  scriptPath: 'scripts/adk_deploy.py',
  stagingBucket: `gs://${GCS_BUCKET}`,
  timeoutMs: 10 * 60 * 1000,
});
if (!dep.ok || !dep.reasoningEngine) {
  console.error(`  Deploy failed: ${dep.error}`);
  process.exit(1);
}
console.log(`  Reasoning Engine: ${dep.reasoningEngine} ✓`);

// ── Step 4: Register ADK agent (ENABLED automatically) ───────────────────────
console.log('\n[4/4] Registering agent...');
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
console.log(`Agent "${AGENT_NAME}" — state=${reg.state}`);
console.log(`Agent ID: ${reg.agentId}`);
console.log(`Visit https://business.gemini.google to verify`);
