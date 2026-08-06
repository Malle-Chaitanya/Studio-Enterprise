/**
 * Inspect the full Agentspace engine resource to understand data store structure.
 * Run: cd server && npx tsx src/spikes/_check_engine_structure.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const DATA_STORE_ID = 'cf-knowledge-eng-hr';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
const engineBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;

console.log(`Engine: ${engineBase}`);

// Get full engine structure
const r = await fetch(engineBase, { headers: { Authorization: `Bearer ${saToken}` } });
const j = await r.json() as Record<string, unknown>;
console.log('\nEngine full structure:');
console.log(JSON.stringify(j, null, 2).slice(0, 5000));

// Also GET collection to see linked data stores
console.log('\n── Collection ──');
const cr = await fetch(
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
const cj = await cr.json() as Record<string, unknown>;
console.log(JSON.stringify(cj, null, 2).slice(0, 2000));

// List ALL data stores in the project
console.log('\n── Data stores in project ──');
const dsr = await fetch(
  `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/dataStores`,
  { headers: { Authorization: `Bearer ${saToken}` } }
);
const dsj = await dsr.json() as { dataStores?: Array<{ name: string; displayName?: string; contentConfig?: string }> };
for (const ds of dsj.dataStores ?? []) {
  console.log(`  ${ds.name.split('/').pop()} — ${ds.displayName ?? ''} (${ds.contentConfig ?? ''})`);
}
