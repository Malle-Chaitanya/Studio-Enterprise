/**
 * Why does the engine reject cf-knowledge-eng-hr even though it IS in
 * engine.dataStoreIds? Compare it field-by-field against the Confluence store the
 * same engine already serves (confluence-test-spike-001-confluence) to find the
 * disqualifying config (industryVertical / solutionTypes / contentConfig / ACL).
 *
 * Run: cd server && npx tsx src/spikes/_diag_ds_engine_compat.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const STORES = ['cf-knowledge-eng-hr', 'confluence-test-spike-001-confluence'];

const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
  ? config.GOOGLE_SA_KEY_JSON
  : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(keyRaw) as { client_email: string; private_key: string };
const jwt = new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const { access_token } = await jwt.authorize();
const h = { Authorization: `Bearer ${access_token}` };
const base = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection`;

const FIELDS = [
  'industryVertical', 'solutionTypes', 'contentConfig', 'aclEnabled', 'createTime',
  'identityMappingStore', 'workspaceConfig', 'kmsKeyName', 'billingEstimation',
];

for (const ds of STORES) {
  const r = await fetch(`${base}/dataStores/${ds}`, { headers: h });
  const j = await r.json() as Record<string, unknown>;
  console.log(`\n═══ ${ds}  [${r.status}]`);
  for (const f of FIELDS) if (j[f] !== undefined) console.log(`  ${f.padEnd(22)} ${JSON.stringify(j[f])}`);

  const sc = await fetch(`${base}/dataStores/${ds}/servingConfigs`, { headers: h });
  const scj = await sc.json() as { servingConfigs?: Array<{ name: string; solutionType?: string }> };
  console.log(`  servingConfigs         ${(scj.servingConfigs ?? []).map((s) => `${s.name.split('/').pop()}(${s.solutionType})`).join(', ') || '(none)'}`);

  // doc count — is anything actually indexed?
  const br = await fetch(`${base}/dataStores/${ds}/branches/default_branch/documents?pageSize=1`, { headers: h });
  const bj = await br.json() as { documents?: unknown[] };
  console.log(`  has documents          ${(bj.documents ?? []).length > 0 ? 'yes' : 'NO / empty'}`);
}

// engine's own serving configs — which stores do they actually bind?
const esc = await fetch(`${base}/engines/${ENGINE}/servingConfigs`, { headers: h });
const escj = await esc.json() as { servingConfigs?: Array<Record<string, unknown>> };
console.log(`\n═══ engine servingConfigs`);
for (const s of escj.servingConfigs ?? []) {
  console.log(`  ${String(s['name']).split('/').pop()}  solutionType=${s['solutionType']}  dataStoreIds=${JSON.stringify(s['dataStoreIds'] ?? s['datastoreIds'] ?? '(not exposed)')}`);
}
