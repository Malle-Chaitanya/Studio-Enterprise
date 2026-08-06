/** Does a data store exist yet, and how many docs are indexed?
 *  npx tsx src/spikes/_diag_ds_docs.ts <dataStoreId> */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const DS = process.argv[2]!;
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}` };
const base = `${HOST}/projects/${P}/locations/global/collections/default_collection/dataStores/${DS}`;
const r = await fetch(base, { headers: h });
console.log(`dataStore GET ${r.status}`);
if (!r.ok) { console.log((await r.text()).replace(/\s+/g,' ').slice(0,200)); process.exit(0); }
const d = await fetch(`${base}/branches/default_branch/documents?pageSize=100`, { headers: h });
const dj = await d.json() as { documents?: Array<{ id?: string; structData?: Record<string,unknown> }> };
console.log(`documents: ${(dj.documents ?? []).length}`);
for (const doc of (dj.documents ?? []).slice(0, 15)) console.log(`  - ${doc.id} ${JSON.stringify(doc.structData ?? {}).slice(0,100)}`);
