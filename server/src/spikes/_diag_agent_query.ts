/**
 * Inspect agent state after "Create" + try the Gemini query API to get the real error.
 * Usage: cd server && npx tsx src/spikes/_diag_agent_query.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_ID     = '8980160511526117673';
const SESSION_ID   = '12600775339713141518'; // from URL in screenshot
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentUrl = `${assistantBase}/agents/${AGENT_ID}`;

// ── Current agent state ───────────────────────────────────────────────────────
console.log('=== Current agent state ===');
const agentRes = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
const agent = await agentRes.json() as Record<string, unknown>;
const lcd = agent.lowCodeAgentDefinition as Record<string, unknown> | undefined;
const deployedNodes = lcd?.deployedNodes as unknown[] | undefined;
console.log(`state:         ${agent.state}`);
console.log(`deployedNodes: ${deployedNodes?.length ?? 0}`);
console.log(`agentFiles:    ${(lcd?.agentFiles as unknown[])?.length ?? 0}`);
console.log(`sharingConfig: ${JSON.stringify(agent.sharingConfig)}`);
if (deployedNodes && deployedNodes.length > 0) {
  const dn = deployedNodes[0] as Record<string, unknown>;
  const llm = dn.llmAgentNode as Record<string, unknown> | undefined;
  console.log(`deployedNodes[0].model: ${llm?.model}`);
}

// ── Try the Conversation/Query API ────────────────────────────────────────────
console.log('\n=== Testing query via API ===');

// 1. Try answer-generation endpoint
const queryBody = {
  query: {
    text: 'What is the Engineering home page about?',
    queryId: 'diag-001',
  },
  session: `${assistantBase}/sessions/${SESSION_ID}`,
  answerGenerationSpec: {
    modelSpec: { modelVersion: 'gemini-2.5-flash' },
    groundingSpec: { includeGroundingSupports: true },
  },
};

const queryRes = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/servingConfigs/default_search:answer`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(queryBody),
  },
);
console.log(`answer endpoint: ${queryRes.status}`);
const queryText = await queryRes.text();
console.log(queryText.slice(0, 500));

// 2. Try agent converse
console.log('\n=== Testing agent converse ===');
const converseBody = {
  query: {
    text: 'Summarise the Engineering home page',
  },
  userMetadata: { userId: GEMINI_ADMIN },
};

const converseRes = await fetch(
  `${assistantBase}/agents/${AGENT_ID}:converse`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(converseBody),
  },
);
console.log(`converse endpoint: ${converseRes.status}`);
const converseText = await converseRes.text();
console.log(converseText.slice(0, 800));
