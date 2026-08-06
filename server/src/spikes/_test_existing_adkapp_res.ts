/**
 * Test existing google-adk framework REs for class_method='query' support.
 * These REs use AdkApp directly (not our wrapper) — deployed by adkDeployer.ts.
 * If AdkApp exposes 'query', these would work with Agentspace.
 *
 * Run: cd server && npx tsx src/spikes/_test_existing_adkapp_res.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT_NUM = '231705905417';
const LOCATION = 'us-central1';
const HOST = 'https://us-central1-aiplatform.googleapis.com/v1beta1';

const token = await getSaToken();

// google-adk framework REs visible in the Agent Runtime console
const GOOGLE_ADK_RES = [
  { id: '3069750153087811584', name: 'Confluence Knowledge Agent (8:36)' },
  { id: '4784915174895512448', name: 'Confluence Knowledge Agent (8:25)' },
  { id: '2645285888208142336', name: 'Confluence Knowledge - Same Project Test' },
];

// Also list ALL REs in SA project to confirm which are google-adk
console.log('[0] All REs in studio-enterprise-migration:');
const lr = await fetch(
  `${HOST}/projects/${SA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines?pageSize=20`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const lj = await lr.json() as {
  reasoningEngines?: Array<{
    name: string; displayName: string; state?: string;
    spec?: { classMethods?: string[] };
  }>
};
for (const re of lj.reasoningEngines ?? []) {
  const id = re.name.split('/').pop();
  const cms = re.spec?.classMethods?.join(', ') ?? 'undefined';
  console.log(`  ${id} — "${re.displayName}" (state=${re.state}, classMethods=[${cms}])`);
}

// Test each google-adk RE
for (const re of GOOGLE_ADK_RES) {
  const RE_PATH = `projects/${SA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${re.id}`;
  console.log(`\n─── Testing ${re.name} (${re.id}) ───`);

  // Test stream_query first (to see if container is warm)
  console.log('  [a] stream_query...');
  const sqr = await fetch(`${HOST}/${RE_PATH}:streamQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'stream_query',
      input: { user_id: 'test-sq', message: 'ping' },
    }),
  });
  console.log(`  stream_query: ${sqr.status}`);
  if (!sqr.ok) {
    const st = await sqr.text();
    const isEconnreset = st.includes('ECONNRESET') || st.includes('connection') || st.includes('upstream');
    console.log(`  ${isEconnreset ? '🔴 cold/down' : '⚠️'}: ${st.slice(0, 150)}`);
    if (isEconnreset) {
      console.log('  Container cold — skipping query test (would also fail)');
      continue;
    }
  } else {
    const sqt = await sqr.text();
    console.log(`  stream_query OK (${sqt.length} bytes)`);
  }

  // Test class_method=query
  console.log('  [b] class_method=query...');
  const qr = await fetch(`${HOST}/${RE_PATH}:streamQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'query',
      input: { user_id: 'test-q', message: 'What is the sick leave policy?' },
    }),
  });
  const qt = await qr.text();
  console.log(`  query: ${qr.status}`);
  if (qr.ok) {
    const answer = qt.split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter(Boolean)
      .flatMap(j => ((j!['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>> ?? []).map(p => p['text'] as string))
      .filter(Boolean).join('').slice(0, 200);
    console.log(`  ✅ QUERY WORKS! Answer: ${answer}`);
  } else {
    const isMethodNotFound = qt.includes('InvocationMethodNotFoundError') || qt.includes('query') && qt.includes('not found');
    console.log(`  ${isMethodNotFound ? '❌ method not found' : '⚠️ other error'}: ${qt.slice(0, 200)}`);
  }
}
