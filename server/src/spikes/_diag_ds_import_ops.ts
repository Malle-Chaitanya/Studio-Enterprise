/** Status of import operations on a data store — did the import actually run?
 *  npx tsx src/spikes/_diag_ds_import_ops.ts <dataStoreId> */
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
for (const path of ['/branches/default_branch/operations', '/operations']) {
  const r = await fetch(`${base}${path}`, { headers: h });
  if (!r.ok) { console.log(`${path} -> ${r.status}`); continue; }
  const j = await r.json() as { operations?: Array<Record<string, any>> };
  console.log(`\n=== ${path} — ${(j.operations ?? []).length} op(s) ===`);
  for (const op of (j.operations ?? []).slice(0, 4)) {
    console.log(`  ${String(op.name).split('/').pop()}  done=${op.done ?? false}`);
    if (op.metadata) console.log(`    meta: ${JSON.stringify(op.metadata).slice(0, 260)}`);
    if (op.error) console.log(`    ERROR: ${JSON.stringify(op.error).slice(0, 300)}`);
    if (op.response) console.log(`    resp: ${JSON.stringify(op.response).slice(0, 260)}`);
  }
}
