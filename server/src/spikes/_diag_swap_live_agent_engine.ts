// Points the REAL, live-registered KB-Grounding-Test-Agent at the NEW,
// verified-working Reasoning Engine (both PDF and SharePoint file grounded
// correctly) instead of the old one that only had the PDF.
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';

const PROJECT = '231705905417';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const AGENT_ID = '7284613592318946592';
const NEW_REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/6268431788427706368';

async function main() {
  const saToken = await getSaToken();
  const dest = { project: PROJECT, engine: ENGINE, assistant: 'default_assistant' };
  const agentUrl = `${assistantBase(dest)}/agents/${AGENT_ID}`;

  const before = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log('before:', JSON.stringify(await before.json(), null, 2));

  const res = await fetch(`${agentUrl}?updateMask=adkAgentDefinition.provisionedReasoningEngine.reasoningEngine`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: agentUrl.replace('https://discoveryengine.googleapis.com/v1alpha/', ''),
      adkAgentDefinition: { provisionedReasoningEngine: { reasoningEngine: NEW_REASONING_ENGINE } },
    }),
  });
  console.log('\nPATCH status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
