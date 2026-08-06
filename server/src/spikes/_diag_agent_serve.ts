/**
 * Diagnose the actual serving error by querying the agent via multiple API paths.
 * The "Something went wrong" in the UI hides the real error — this exposes it.
 *
 * Usage: cd server && npx tsx src/spikes/_diag_agent_serve.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_ID     = '8980160511526117673';
const HOST         = 'https://discoveryengine.googleapis.com/v1alpha';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const assistantBase =
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection` +
  `/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentUrl = `${assistantBase}/agents/${AGENT_ID}`;

// ── 1. Full agent state ───────────────────────────────────────────────────────
console.log('=== 1. Full agent state ===');
const agentRes = await fetch(agentUrl, { headers: { Authorization: `Bearer ${saToken}` } });
const agent = await agentRes.json() as Record<string, unknown>;
const lcd = agent.lowCodeAgentDefinition as Record<string, unknown> | undefined;
const deployedNodes = lcd?.deployedNodes as unknown[] | undefined;
const nodes = lcd?.nodes as Array<Record<string, unknown>> | undefined;
const node0 = nodes?.[0];
const llm = node0?.llmAgentNode as Record<string, unknown> | undefined;
console.log(`state:         ${agent.state}`);
console.log(`deployedNodes: ${deployedNodes?.length ?? 0}`);
console.log(`agentFiles:    ${(lcd?.agentFiles as unknown[])?.length ?? 0}`);
console.log(`sharingConfig: ${JSON.stringify(agent.sharingConfig)}`);
console.log(`model:         ${llm?.model}`);
console.log(`selectedTools: ${JSON.stringify(llm?.selectedTools)}`);

// ── 2. Try agent converse ─────────────────────────────────────────────────────
console.log('\n=== 2. Agent :converse ===');
const convRes = await fetch(`${agentUrl}:converse`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { text: 'Hello' } }),
});
const convText = await convRes.text();
console.log(`Status: ${convRes.status}`);
console.log(`Body:   ${convText.slice(0, 600)}`);

// ── 3. Create agent session and query ─────────────────────────────────────────
console.log('\n=== 3. Agent session create + streamAnswer ===');
const sessRes = await fetch(`${agentUrl}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
console.log(`createSession status: ${sessRes.status}`);
const sessText = await sessRes.text();
console.log(`Body: ${sessText.slice(0, 300)}`);

let sessId = '';
try {
  const j = JSON.parse(sessText) as { name?: string };
  sessId = j.name?.split('/').pop() ?? '';
} catch { /* ignore */ }

if (sessId) {
  const streamRes = await fetch(`${agentUrl}/sessions/${sessId}:streamAnswer`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: 'Hello' } }),
  });
  console.log(`\nstreamAnswer status: ${streamRes.status}`);
  const streamText = await streamRes.text();
  console.log(`Body: ${streamText.slice(0, 800)}`);
}

// ── 4. Assistant-level streamAnswer ──────────────────────────────────────────
console.log('\n=== 4. Assistant-level :answer (specifying agentId) ===');
const ansRes = await fetch(
  `${assistantBase}:streamAnswer`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: AGENT_ID,
      query: { text: 'Hello' },
      querySpec: { agentId: AGENT_ID },
    }),
  },
);
console.log(`Status: ${ansRes.status}`);
const ansText = await ansRes.text();
console.log(`Body: ${ansText.slice(0, 600)}`);

// ── 5. Check agentFiles content (first one) ───────────────────────────────────
console.log('\n=== 5. Sample agentFile content ===');
const agentFiles = lcd?.agentFiles as Array<Record<string, unknown>> | undefined;
const firstFile = agentFiles?.[0];
if (firstFile) {
  console.log(`File ID: ${firstFile.id}`);
  console.log(`File name: ${firstFile.name}`);
  const doc = firstFile.document as Record<string, unknown> | undefined;
  const rawContent = doc?.rawBytes as string | undefined;
  if (rawContent) {
    const bytes = Buffer.from(rawContent, 'base64');
    console.log(`Content size: ${bytes.length} bytes`);
    console.log(`Content preview: ${bytes.toString('utf8').slice(0, 200)}`);
  } else {
    console.log(`document keys: ${Object.keys(doc ?? {}).join(', ')}`);
  }
} else {
  console.log('No agentFiles found in response');
}

// ── 6. Check deployedNodes model vs nodes model ───────────────────────────────
console.log('\n=== 6. Deployed vs Draft node comparison ===');
const dn0 = deployedNodes?.[0] as Record<string, unknown> | undefined;
const dnLlm = dn0?.llmAgentNode as Record<string, unknown> | undefined;
console.log(`nodes[0].model:         ${llm?.model}`);
console.log(`deployedNodes[0].model: ${dnLlm?.model ?? '(empty)'}`);
console.log(`nodes[0].instruction:   ${String(llm?.instruction ?? '').slice(0, 100)}...`);
console.log(`dn[0].instruction:      ${String(dnLlm?.instruction ?? '').slice(0, 100) || '(empty)'}...`);
