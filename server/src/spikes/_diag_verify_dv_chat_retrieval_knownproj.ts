/**
 * Live check (attempt 2): does a MIGRATED agent's chat actually retrieve and
 * answer from a Dataverse-snapshot knowledge source? Runs against the KNOWN
 * -WORKING test project (231705905417) that earlier ADK tests in
 * decisions.md already deployed through successfully (staging bucket +
 * Reasoning Engine Discovery Engine access already provisioned there) —
 * the original attempt against 72860638029 failed on a missing GCS
 * staging-bucket permission before anything billable was created.
 *
 * Steps: (1) re-create the real Dataverse contacts snapshot in this project,
 * (2) read back its actual row content, (3) deploy a throwaway ADK agent
 * grounded on it, (4) ask a question only answerable from that row.
 *   npx tsx src/spikes/_diag_verify_dv_chat_retrieval_knownproj.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveDestination } from '../services/gemini.js';
import { migrateDataverseSnapshot } from '../services/knowledgeDataStoreExecutor.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { verifyAgent } from '../services/verify.js';
import type { AgentIR, KnowledgeSourceIR } from '../types.js';

const GEMINI_PROJECT = '231705905417';
const G_EMAIL = 'zara@storefuze.com';
const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const TABLE = 'contacts';

async function listDocs(project: string, saToken: string, dataStoreId: string) {
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${dataStoreId}/branches/0/documents`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, doc: json.documents?.[0]?.structData ?? null };
}

async function main() {
  await connectMongo();
  const saToken = await getSaToken(G_EMAIL);
  const dest = await resolveDestination(GEMINI_PROJECT, saToken);
  console.log(`project=${dest.project} engine=${dest.engine}`);

  console.log('\n1) Re-creating the real Dataverse contacts snapshot in this project...');
  const dvToken = await clientCredsToken(TENANT_ID, ENV_URL);
  const source: KnowledgeSourceIR = {
    id: `spiketest-${TABLE}`,
    name: `${TABLE} (chat-retrieval spike)`,
    kind: 'DataverseTableSearch',
    reference: TABLE,
    references: [TABLE],
  };
  const snap = await migrateDataverseSnapshot(dest, saToken, dvToken, ENV_URL, `spiketest-chatretrieval-${Date.now().toString(36)}`, source);
  console.log('   snapshot result:', JSON.stringify(snap, null, 2));
  if (!snap.dataStoreId || snap.attempted === 0) {
    console.log('SNAPSHOT FAILED — stopping.');
    process.exit(1);
  }

  console.log('\n2) Reading back the real row content...');
  const found = await listDocs(dest.project, saToken, snap.dataStoreId);
  console.log('   list status:', found.status);
  if (!found.doc) {
    console.log('   NO DOCUMENT FOUND — stopping before deploy.');
    process.exit(1);
  }
  const nameField = ['fullname', 'name', 'firstname', 'lastname', 'emailaddress1'].find((f) => found.doc[f]);
  const probeValue = nameField ? found.doc[nameField] : JSON.stringify(found.doc).slice(0, 60);
  console.log(`   field "${nameField}" = "${probeValue}"`);

  console.log('\n3) Deploying throwaway ADK agent grounded on this store...');
  const ir = {
    name: 'DV-Chat-Retrieval-Test-Agent-2',
    description: 'Diagnostic — verifies a migrated agent can actually retrieve from a Dataverse-snapshot knowledge source. Safe to delete.',
    instructions:
      'You are a diagnostic test assistant grounded on a Dataverse contacts table snapshot. When asked about a ' +
      'contact, answer ONLY using the knowledge source data available to you, and quote the specific field values ' +
      'you found. If you cannot find the answer in your knowledge source, say so plainly instead of guessing.',
    capabilities: {},
    knowledgeSources: [],
  } as unknown as AgentIR;

  const adk = await publishAgentToGallery(dest, saToken, ir, {
    groundingDataStores: [{ resourcePath: snap.resourcePath!, sourceName: 'contacts (Dataverse snapshot)' }],
  });
  console.log('   deploy result:', JSON.stringify(adk, null, 2));
  if (!adk.ok || !adk.agentId) {
    console.log('DEPLOY FAILED — stopping.');
    process.exit(1);
  }

  console.log('\n4) Asking the deployed agent about the real contact...');
  await new Promise((r) => setTimeout(r, 8000));
  const probe = `Look up the contact record. What is the value of "${nameField}"? Quote it exactly.`;
  const v = await verifyAgent(dest, saToken, adk.agentId, probe);
  console.log('   verified:', v.verified);
  console.log('   note:', v.note);
  console.log('   ANSWER:', v.sample);

  console.log('\n--- SUMMARY ---');
  console.log(`expected value: "${probeValue}"`);
  const hit = typeof v.sample === 'string' && String(probeValue) && v.sample.includes(String(probeValue));
  console.log(hit
    ? `CONFIRMED: the agent's answer contains the real Dataverse field value — chat retrieval from Dataverse knowledge WORKS.`
    : `NOT CONFIRMED: the answer did not contain the expected value — either grounding isn't reaching the agent at query time, or the assist probe itself is broken/unavailable.`);
  console.log(`New agent id: ${adk.agentId}`);
  console.log(`New reasoning engine: ${adk.reasoningEngine}`);
  console.log('Delete this test agent + its Reasoning Engine once done (no automated cleanup exists yet).');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message, e.stack);
    process.exit(1);
  });
