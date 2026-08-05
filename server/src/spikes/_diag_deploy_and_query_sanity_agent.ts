// Deploys the ADK agent grounded on the now-successfully-imported sanity-check
// file, then asks it the real content questions.
//   npx tsx src/spikes/_diag_deploy_and_query_sanity_agent.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';
import type { AgentIR, GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const DATA_STORE_ID = 'adk-file-grounding-sanity-check-file-sanity-check-facts-txt';
const SECRET_MARKER = 'ZX-CONFLICT-7742';

async function main() {
  const saToken = await getSaToken();
  const resourcePath = dataStoreResourcePath(DEST.project, DATA_STORE_ID);

  console.log('Deploying ADK agent via the FIXED publishAgentToGallery, grounded on the now-populated file store...');
  const ir = {
    name: 'ADK-File-Grounding-Sanity-Check',
    description: 'Diagnostic — clean sanity check for the ADK knowledge-parity fix using a known-content uploaded file. Safe to delete.',
    instructions:
      'You are a diagnostic test assistant. Answer every question using whatever knowledge sources are ' +
      'available to you. If you use a knowledge source, quote the exact relevant text. If you cannot find ' +
      'relevant information anywhere, say so plainly instead of guessing.',
    capabilities: {},
  } as unknown as AgentIR;

  const adk = await publishAgentToGallery(DEST, saToken, ir, { groundingDataStores: [resourcePath] });
  console.log('->', JSON.stringify(adk, null, 2));
  if (!adk.ok || !adk.reasoningEngine) {
    console.log('DEPLOY FAILED — stopping.');
    return;
  }

  console.log('Waiting 8s for registration to settle...');
  await new Promise((r) => setTimeout(r, 8000));

  const ask = async (message: string) => {
    const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${adk.reasoningEngine}:streamQuery?alt=sse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'file-grounding-sanity-2', message } }),
    });
    console.log(`\n>>> ${message}`);
    console.log('status:', res.status);
    console.log(await res.text());
  };

  await ask('What secret test marker is mentioned in your knowledge source? Quote it exactly.');
  await ask('What MongoDB query do I use to get the Conflict report for a onetime migration? Quote it exactly.');
  await ask('What is the capital of France?');

  console.log('\n--- SUMMARY ---');
  console.log(`New agent id: ${adk.agentId}`);
  console.log(`New reasoning engine: ${adk.reasoningEngine}`);
  console.log(`If the first two answers above contain "${SECRET_MARKER}" and the real MongoDB query text,`);
  console.log('the ADK grounding fix works end to end, cleanly, independent of the SharePoint fixture.');
}
main().catch((e) => console.error('FATAL:', e.message));
