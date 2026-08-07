/** SharePoint connectors live in their OWN collections, not default_collection.
 *  Inspect each collection's dataConnector for ACL/identity config. Read-only.
 *  npx tsx src/spikes/_diag_sp_connector_collections.ts */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}` };
const base = `${HOST}/projects/${P}/locations/global`;

const cr = await fetch(`${base}/collections?pageSize=100`, { headers: h });
const cj = await cr.json() as { collections?: Array<{ name: string; displayName?: string }> };
const cols = cj.collections ?? [];
console.log(`${cols.length} collection(s)\n`);

for (const c of cols) {
  const id = c.name.split('/').pop()!;
  if (id === 'default_collection') continue;
  const dc = await fetch(`${base}/collections/${id}/dataConnector`, { headers: h });
  if (!dc.ok) continue;
  const d = await dc.json() as Record<string, any>;
  console.log(`── ${id}  (${c.displayName ?? ''})`);
  console.log(`   dataSource             : ${d.dataSource}`);
  console.log(`   state                  : ${d.state}`);
  console.log(`   aclEnabled             : ${d.aclEnabled ?? '(unset)'}`);
  console.log(`   identityRefreshInterval: ${JSON.stringify(d.identityRefreshInterval ?? null)}`);
  console.log(`   identityScheduleConfig : ${JSON.stringify(d.identityScheduleConfig ?? null)}`);
  console.log(`   entities               : ${(d.entities ?? []).map((e: any) => `${e.entityName}->${(e.dataStore ?? '').split('/').pop()}`).join(', ')}`);
  // Does the entity's data store carry ACLs?
  for (const e of d.entities ?? []) {
    if (!e.dataStore) continue;
    const dsr = await fetch(`${HOST}/${e.dataStore}`, { headers: h });
    if (!dsr.ok) continue;
    const ds = await dsr.json() as Record<string, any>;
    console.log(`     store ${String(ds.name).split('/').pop()}: aclEnabled=${ds.aclEnabled ?? false} idMapStore=${ds.identityMappingStore ?? '-'}`);
  }
  console.log('');
}
