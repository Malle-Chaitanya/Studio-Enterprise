/** Check whether the new agent (created after the groundingDataStores fix)
 * actually has dataStoreSpecs wired on its lowCodeAgentDefinition — the
 * mechanism a real console agent uses for structured/connector grounding,
 * confirmed missing on the PREVIOUS agent (3027457323471599777).
 *   npx tsx src/spikes/_diag_verify_grounding_fix.ts
 * READ-ONLY.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const NEW_AGENT_ID = '15548326869180890514';

async function main() {
  const saToken = await getSaToken('zara@storefuze.com');
  const url = `${assistantBase(DEST)}/agents/${NEW_AGENT_ID}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as any;
  console.log('status:', res.status);
  const node = json.lowCodeAgentDefinition?.nodes?.[0]?.llmAgentNode;
  console.log('\nselectedTools:', JSON.stringify(node?.selectedTools));
  console.log('\ndataStoreSpecs:', JSON.stringify(node?.dataStoreSpecs, null, 2));
  const specs = node?.dataStoreSpecs?.specs ?? [];
  console.log(`\n--- RESULT ---`);
  console.log(specs.length ? `CONFIRMED: ${specs.length} dataStoreSpecs entrie(s) wired.` : 'NOT WIRED: dataStoreSpecs is empty/missing.');
  for (const s of specs) console.log('  -', s.dataStore);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
