// Verifies the multi-store ADK fix end-to-end WITHOUT spending any of the
// scarce agent-creation quota: deployReasoningEngine() alone (Vertex AI
// Reasoning Engine creation) is a SEPARATE API from registerAdkAgent()
// (Discovery Engine's agents.create/register, which is what the ~7/day
// undocumented quota actually gates — see docs/SUPPORT-TICKET-AGENT-QUOTA.md).
// Querying via :streamQuery works directly against the raw reasoning engine
// resource, no registration needed (already proven earlier this investigation).
// This deploys a real, throwaway Reasoning Engine, tests it with real content
// questions from TWO combined data stores, then leaves cleanup instructions —
// it never calls registerAdkAgent, so zero quota risk either way.
//   npx tsx src/spikes/_diag_verify_multistore_fix_no_quota.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { buildAdkSpec, deployReasoningEngine } from '../services/adkDeployer.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';
import type { AgentIR } from '../types.js';

const PROJECT = '231705905417';
const LOCATION = 'us-central1';

// Two already-existing, already-proven data stores — same multi-store shape
// as the real KB-Grounding-Test-Agent (a file store + the SharePoint store).
const STORE_1 = 'adk-file-grounding-sanity-check-file-sanity-check-facts-txt';
const STORE_2 = 'filefuze-sp-d4a33c3a8821_file';

async function main() {
  const saToken = await getSaToken();

  const ir = {
    name: 'MultiStore-Fix-NoQuota-Verify',
    description: 'Diagnostic — verifies the multi-store ADK fix without touching agent-creation quota. Safe to delete.',
    instructions:
      'You are a diagnostic test assistant. Answer every question using whatever knowledge sources are ' +
      'available to you. Quote the exact relevant text and name which source you used.',
    capabilities: {},
  } as unknown as AgentIR;

  const groundingDataStores = [
    dataStoreResourcePath(PROJECT, STORE_1),
    dataStoreResourcePath(PROJECT, STORE_2),
  ];
  const spec = buildAdkSpec(ir, { groundingDataStores });
  console.log('Deploying (Reasoning Engine only, no registration, no quota spent)...');
  const dep = await deployReasoningEngine(PROJECT, LOCATION, spec);
  console.log('->', JSON.stringify(dep, null, 2));
  if (!dep.ok || !dep.reasoningEngine) {
    console.log('DEPLOY FAILED.');
    return;
  }

  console.log('Waiting 8s, then querying with real content questions from BOTH stores...');
  await new Promise((r) => setTimeout(r, 8000));

  const ask = async (message: string) => {
    const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${dep.reasoningEngine}:streamQuery?alt=sse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'no-quota-verify', message } }),
    });
    console.log(`\n>>> ${message}`);
    console.log('status:', res.status);
    console.log((await res.text()).slice(0, 3000));
  };

  await ask('What is the capital of France?'); // control — needs no tool at all
  await ask('What secret test marker is mentioned in one of your knowledge sources? Quote it exactly.');
  await ask('What is mentioned about a Conflict report for a onetime migration? Quote the exact MongoDB query.');

  console.log('\n--- SUMMARY ---');
  console.log('Reasoning engine (throwaway, never registered, delete when done):', dep.reasoningEngine);
  console.log('If ALL THREE answers above came back with real text (not an ImportError, not empty),');
  console.log('the fix works end-to-end and your real re-migration should succeed cleanly.');
}
main().catch((e) => console.error('FATAL:', e.message));
