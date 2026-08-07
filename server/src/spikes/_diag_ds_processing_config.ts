/** What parsing/chunking config do our data stores actually have? Read-only.
 *  npx tsx src/spikes/_diag_ds_processing_config.ts [dataStoreId...] */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const IDS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['e2e-itinfra-sales-confluence', 'connectortest_1785961359928_file', 'cf-knowledge-eng-hr'];
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}` };
for (const id of IDS) {
  const url = `${HOST}/projects/${P}/locations/global/collections/default_collection/dataStores/${id}/documentProcessingConfig`;
  const r = await fetch(url, { headers: h });
  const j = await r.json();
  console.log(`\n=== ${id} [${r.status}] ===`);
  console.log(JSON.stringify(j, null, 2).slice(0, 900));
}
