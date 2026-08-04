import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/2047679328279330816';
const AGENT_ID = '3979879510128523003';
const PROJECT = '231705905417';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';

async function main() {
  const saToken = await getSaToken();

  console.log('=== Reasoning Engine resource (Vertex AI) ===');
  const reRes = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log(reRes.status, JSON.stringify(await reRes.json(), null, 2));

  console.log('\n=== Registered agent resource (Discovery Engine) ===');
  const agentUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT_ID}`;
  const agRes = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log(agRes.status, JSON.stringify(await agRes.json(), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
