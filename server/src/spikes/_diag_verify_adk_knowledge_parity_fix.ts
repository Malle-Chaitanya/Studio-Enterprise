// Verifies the 2026-08-04 ADK knowledge-parity fix end to end against the real
// destination project, without needing a live Microsoft/Dataverse session
// (the fix itself is entirely Google-side — publishAgentToGallery's
// groundingDataStores wiring — so this exercises the exact changed code path):
//   1. Delete the stale registered agent from the ORIGINAL broken run.
//   2. Clear its adkDeployments Mongo cache record so nothing short-circuits.
//   3. Deploy a FRESH ADK agent via the real, fixed publishAgentToGallery(),
//      grounded on the same already-provisioned SharePoint data store
//      (daily_queries.txt) that the original bug report was about.
//   4. Ask it a real content question from that file and print the answer —
//      the actual proof, not just "verified: true".
// Safe to delete afterward — this creates one new, clearly-named test agent.
//   npx tsx src/spikes/_diag_verify_adk_knowledge_parity_fix.ts
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { getSaToken } from '../auth/google.js';
import { deleteAgent } from '../services/gemini.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { verifyAgent } from '../services/verify.js';
import type { AgentIR, GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const SOURCE_ID = '124794af-3b8f-f111-b8da-0022480b1f83'; // KB-Grounding-Test-Agent's Copilot botid
const STALE_REGISTERED_AGENT_ID = '6973043416271899117'; // from the original broken run's adkDeployments record
const STALE_REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/7089916507957755904';
const SHAREPOINT_DATA_STORE_ID = 'filefuze-sp-d4a33c3a8821_file'; // daily_queries.txt connector, already provisioned

async function main() {
  const saToken = await getSaToken();

  console.log('1) Deleting stale registered agent from the broken run...');
  const del = await deleteAgent(DEST, saToken, STALE_REGISTERED_AGENT_ID);
  console.log('   ->', JSON.stringify(del));
  console.log(`   NOTE: the underlying Reasoning Engine (${STALE_REASONING_ENGINE}) is NOT deleted by`);
  console.log('   this script — this codebase has no reasoningEngines.delete helper yet. Delete it');
  console.log('   manually once done here: gcloud ai reasoning-engines delete ' + STALE_REASONING_ENGINE.split('/').pop() +
    ' --project=231705905417 --region=us-central1');

  console.log('2) Clearing adkDeployments Mongo cache record...');
  const client = new MongoClient(process.env.MONGO_HOST || 'mongodb://localhost:27019');
  await client.connect();
  const db = client.db(process.env.CSGE_DB || 'csge');
  const clear = await db.collection('adkDeployments').deleteMany({ sourceId: SOURCE_ID });
  console.log('   -> deleted', clear.deletedCount, 'record(s)');
  await client.close();

  console.log('3) Deploying a FRESH ADK agent via the FIXED publishAgentToGallery, grounded on the SharePoint store...');
  const ir = {
    name: 'KB-Grounding-Test-Agent-ADK-Fix-Verify',
    description: 'Diagnostic — verifies the 2026-08-04 ADK grounding parity fix (SharePoint knowledge now reaches ADK agents). Safe to delete.',
    instructions:
      'You are a diagnostic test assistant. Answer every question using whatever knowledge sources are ' +
      'available to you. If you use a knowledge source, say explicitly which one you used. If you cannot ' +
      'find relevant information anywhere, say so plainly instead of guessing.',
    capabilities: {},
  } as unknown as AgentIR;

  const resourcePath = dataStoreResourcePath(DEST.project, SHAREPOINT_DATA_STORE_ID);
  const adk = await publishAgentToGallery(DEST, saToken, ir, { groundingDataStores: [resourcePath] });
  console.log('   ->', JSON.stringify(adk, null, 2));

  if (!adk.ok || !adk.agentId) {
    console.log('DEPLOY FAILED — stopping before verification.');
    return;
  }

  console.log('4) Asking the deployed agent a real content question from daily_queries.txt...');
  // Wait a few seconds for registration to settle before probing.
  await new Promise((r) => setTimeout(r, 5000));
  const v = await verifyAgent(DEST, saToken, adk.agentId, 'What MongoDB query do I use to get the Conflict report for a onetime migration?');
  console.log('   verified:', v.verified);
  console.log('   note:', v.note);
  console.log('   ANSWER:', v.sample);

  console.log('\n--- SUMMARY ---');
  console.log('New agent id:', adk.agentId);
  console.log('New reasoning engine:', adk.reasoningEngine);
  console.log('groundingIamGranted:', adk.groundingIamGranted, adk.groundingIamError ?? '');
  console.log('If the ANSWER above actually names/quotes a real MongoDB query for a "Conflict report",');
  console.log('the fix works — the ADK agent retrieved from the SharePoint knowledge source. If it gave');
  console.log('a generic/refusal answer instead, grounding still is not reaching the agent at query time.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
