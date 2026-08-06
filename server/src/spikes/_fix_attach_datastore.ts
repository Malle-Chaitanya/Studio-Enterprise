/**
 * Root cause: the agent's dataStoreSpecs point at cf-knowledge-eng-hr, but that data
 * store is NOT in engine.dataStoreIds — the engine cannot see it, so every grounded
 * path fails ("Data stores ... not found in the engine", assist "temporary system
 * error"). Fix: add the data store to the engine, then re-run the answer proof.
 *
 * Read-only unless run with `--apply`.
 *   cd server && npx tsx src/spikes/_fix_attach_datastore.ts          # inspect
 *   cd server && npx tsx src/spikes/_fix_attach_datastore.ts --apply  # attach
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const DS_ID = 'cf-knowledge-eng-hr';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

async function getSaToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const c = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const { access_token } = await c.authorize();
  if (!access_token) throw new Error('no token');
  return access_token;
}

const token = await getSaToken();
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const collBase = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection`;
const engineUrl = `${collBase}/engines/${ENGINE}`;

// ── 1. What data stores exist in the collection? ──────────────────────────────
const dsr = await fetch(`${collBase}/dataStores?pageSize=100`, { headers: h });
const dsj = await dsr.json() as { dataStores?: Array<{ name: string; displayName?: string; industryVertical?: string }> };
console.log('=== data stores in collection ===');
for (const ds of dsj.dataStores ?? []) {
  console.log(`  ${(ds.name.split('/').pop() ?? '').padEnd(34)} ${ds.displayName ?? ''}`);
}

// ── 2. What is attached to the engine? ────────────────────────────────────────
const er = await fetch(engineUrl, { headers: h });
const ej = await er.json() as { dataStoreIds?: string[]; solutionType?: string; appType?: string; displayName?: string };
console.log('\n=== engine ===');
console.log(`  displayName  : ${ej.displayName}`);
console.log(`  solutionType : ${ej.solutionType}   appType: ${ej.appType}`);
console.log(`  dataStoreIds : ${JSON.stringify(ej.dataStoreIds ?? [])}`);
console.log(`  ${DS_ID} attached? ${(ej.dataStoreIds ?? []).includes(DS_ID) ? 'YES' : 'NO'}`);

if ((ej.dataStoreIds ?? []).includes(DS_ID)) {
  console.log('\nAlready attached — nothing to do.');
  process.exit(0);
}
if (!APPLY) {
  console.log('\n(dry run) re-run with --apply to attach.');
  process.exit(0);
}

// ── 3. Attach ─────────────────────────────────────────────────────────────────
const next = [...(ej.dataStoreIds ?? []), DS_ID];
console.log(`\nPATCH dataStoreIds -> ${JSON.stringify(next)}`);
const pr = await fetch(`${engineUrl}?updateMask=dataStoreIds`, {
  method: 'PATCH', headers: h, body: JSON.stringify({ dataStoreIds: next }),
});
const pt = await pr.text();
console.log(`  ${pr.status}  ${pt.replace(/\s+/g, ' ').slice(0, 400)}`);

const er2 = await fetch(engineUrl, { headers: h });
const ej2 = await er2.json() as { dataStoreIds?: string[] };
console.log(`\nAFTER dataStoreIds: ${JSON.stringify(ej2.dataStoreIds ?? [])}`);
