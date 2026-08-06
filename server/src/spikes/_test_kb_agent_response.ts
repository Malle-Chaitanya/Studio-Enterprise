/**
 * End-to-end test: verify knowledge base has content AND agent gives response.
 *
 * Steps:
 *  1. Search the data store directly → proves content is indexed
 *  2. Check the agent definition → proves dataStoreSpecs is wired
 *  3. Invoke the agent chat API → get an actual response
 *
 * Run: cd server && npx tsx src/spikes/_test_kb_agent_response.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT     = 'sonorous-lightning-t224x';
const GCP_PROJECT_NUM = '521161651560';
const GEMINI_ADMIN    = 'mia@cloudfuze.com';
const HOST            = 'https://discoveryengine.googleapis.com/v1alpha';

// The agent we created earlier with confluence-knowledge-agent-all connected
const TEST_AGENT_ID   = '11632552002298015870';
const DATA_STORE_ID   = 'confluence-knowledge-agent-all';

const TEST_QUESTIONS = [
  'What is the sick leave policy?',
  'Tell me about the engineering standards.',
  'What tools does the company use?',
];

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

const collBase  = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const agentBase = `${collBase}/engines/${dest.engine}/assistants/${dest.assistant}/agents`;

// ── STEP 1: Search the data store directly ───────────────────────────────────
console.log('═══ STEP 1: Query data store directly ═══');
console.log(`Data store: ${DATA_STORE_ID}`);
console.log(`Question  : "${TEST_QUESTIONS[0]}"\n`);

const searchUrl = `${collBase}/dataStores/${DATA_STORE_ID}/servingConfigs/default_config:search`;
const searchR = await fetch(searchUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: TEST_QUESTIONS[0],
    pageSize: 5,
    queryExpansionSpec: { condition: 'AUTO' },
    spellCorrectionSpec: { mode: 'AUTO' },
    contentSearchSpec: {
      snippetSpec: { returnSnippet: true },
      summarySpec: {
        summaryResultCount: 3,
        includeCitations: true,
        ignoreAdversarialQuery: true,
      },
    },
  }),
});

const searchJ = await searchR.json() as {
  results?: Array<{
    document?: {
      name?: string;
      derivedStructData?: {
        title?: { stringValue?: string };
        link?: { stringValue?: string };
        snippets?: Array<{ snippet?: { stringValue?: string } }>;
      };
    };
  }>;
  summary?: { summaryText?: string };
};

if (!searchR.ok) {
  console.log(`Search failed: ${searchR.status} — ${JSON.stringify(searchJ).slice(0, 300)}`);
} else {
  const results = searchJ.results ?? [];
  console.log(`Found ${results.length} result(s):`);
  for (const r of results) {
    const sd = r.document?.derivedStructData;
    const title   = sd?.title?.stringValue ?? '(no title)';
    const snippet = sd?.snippets?.[0]?.snippet?.stringValue ?? '';
    console.log(`  📄 ${title}`);
    if (snippet) console.log(`     ${snippet.replace(/<[^>]+>/g, '').slice(0, 120)}…`);
  }
  if (searchJ.summary?.summaryText) {
    console.log(`\n  ✨ AI Summary:\n  ${searchJ.summary.summaryText.slice(0, 400)}`);
  }
  if (results.length === 0) {
    console.log('  ⚠ No results — data store may be empty or still indexing.');
  }
}

// ── STEP 2: Verify agent has dataStoreSpecs wired ────────────────────────────
console.log('\n═══ STEP 2: Check agent definition ═══');
const agentR = await fetch(`${agentBase}/${TEST_AGENT_ID}`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const agentJ = await agentR.json() as Record<string, unknown>;
const lcd = agentJ['lowCodeAgentDefinition'] as Record<string, unknown> | undefined;
const nodes = (lcd?.['nodes'] as Array<Record<string, unknown>>) ?? [];
const rootNode = nodes.find(n => n['id'] === 'root_agent');
const llmNode = rootNode?.['llmAgentNode'] as Record<string, unknown> | undefined;
const dsSpecs = llmNode?.['dataStoreSpecs'] as Record<string, unknown> | undefined;
const specs = (dsSpecs?.['specs'] as Array<Record<string, unknown>>) ?? [];

console.log(`Agent state    : ${agentJ['state']}`);
console.log(`dataStoreSpecs : ${specs.length > 0 ? '✅ wired' : '❌ missing'}`);
for (const s of specs) {
  console.log(`  → ${s['dataStore']}`);
}

// ── STEP 3: Try agent chat API ────────────────────────────────────────────────
console.log('\n═══ STEP 3: Invoke agent chat API ═══');
console.log('(Low-code agents use the Gemini chat endpoint — testing now…)\n');

// Try the agent session/query API
const sessionUrl = `${agentBase}/${TEST_AGENT_ID}/sessions`;

// Create a session first
const sessR = await fetch(sessionUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
const sessT = await sessR.text();
console.log(`Create session: ${sessR.status}`);

if (sessR.ok) {
  const sessJ = JSON.parse(sessT) as Record<string, unknown>;
  const sessionName = String(sessJ['name'] ?? '');
  const sessionId   = sessionName.split('/').pop()!;
  console.log(`Session ID: ${sessionId}`);

  // Send a query to the session
  const answerUrl = `${agentBase}/${TEST_AGENT_ID}/sessions/${sessionId}/answers`;
  for (const question of TEST_QUESTIONS) {
    console.log(`\n  Q: "${question}"`);
    const ansR = await fetch(answerUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { text: question } }),
    });
    const ansT = await ansR.text();
    if (ansR.ok) {
      const ansJ = JSON.parse(ansT) as Record<string, unknown>;
      const answer = (ansJ['answer'] as Record<string, unknown> | undefined);
      const text   = answer?.['answerText'] as string | undefined;
      console.log(`  A: ${text?.slice(0, 300) ?? JSON.stringify(ansJ).slice(0, 300)}`);
    } else {
      console.log(`  Error ${ansR.status}: ${ansT.slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
} else {
  // Sessions API not available for this agent type — try direct answer
  console.log('Sessions API not available. Trying direct agent answer endpoint…');
  const directUrl = `${agentBase}/${TEST_AGENT_ID}:answer`;
  for (const question of TEST_QUESTIONS.slice(0, 1)) {
    const r = await fetch(directUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { text: question } }),
    });
    console.log(`  Direct answer: ${r.status} — ${(await r.text()).slice(0, 300)}`);
  }
}

// ── STEP 4: Also test mia's working agent (7099475012136461191) ──────────────
console.log('\n═══ STEP 4: Test mia\'s known-working agent (hybrid stores) ═══');
const MIA_AGENT = '7099475012136461191';
const miaSessR = await fetch(`${agentBase}/${MIA_AGENT}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
console.log(`Create session for mia's agent: ${miaSessR.status}`);
if (miaSessR.ok) {
  const miaSessJ = await miaSessR.json() as Record<string, unknown>;
  const miaSessId = String(miaSessJ['name']).split('/').pop()!;
  const miaAnsUrl = `${agentBase}/${MIA_AGENT}/sessions/${miaSessId}/answers`;
  const q = TEST_QUESTIONS[0];
  console.log(`  Q: "${q}"`);
  const miaAnsR = await fetch(miaAnsUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: q } }),
  });
  const miaAnsT = await miaAnsR.text();
  if (miaAnsR.ok) {
    const j = JSON.parse(miaAnsT) as Record<string, unknown>;
    const ans = (j['answer'] as Record<string, unknown> | undefined);
    console.log(`  A: ${(ans?.['answerText'] as string)?.slice(0, 400) ?? miaAnsT.slice(0, 300)}`);
  } else {
    console.log(`  Error ${miaAnsR.status}: ${miaAnsT.slice(0, 200)}`);
  }
}

console.log('\n═══ SUMMARY ═══');
console.log('Step 1 (data store search): see results above');
console.log('Step 2 (agent wiring)     : see dataStoreSpecs above');
console.log('Step 3 (agent chat API)   : see response above');
console.log('\nIf Step 1 returned results but Step 3 failed:');
console.log('  → Data store has content, but low-code agent chat API needs different endpoint.');
console.log('  → Test via: business.gemini.google → Agents → "Confluence Test Agent (Path A)" → Chat');
