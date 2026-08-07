/** Does the SharePoint path support ACL-aware indexing in THIS project?
 *  Read-only: inspects existing connectors, their data stores, and identity mapping stores.
 *  npx tsx src/spikes/_diag_sharepoint_acl_support.ts */
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

// 1. Identity mapping stores — the per-user ACL mechanism for third-party identities
const ims = await fetch(`${base}/identityMappingStores`, { headers: h });
const imsJ = await ims.json() as { identityMappingStores?: Array<{ name: string }> };
console.log(`=== identityMappingStores [${ims.status}] ===`);
console.log(`  ${(imsJ.identityMappingStores ?? []).map((s) => s.name.split('/').pop()).join(', ') || '(none created)'}`);

// 2. The collection's data connector (SharePoint lives here)
const dc = await fetch(`${base}/collections/default_collection/dataConnector`, { headers: h });
const dcJ = await dc.json() as Record<string, any>;
console.log(`\n=== dataConnector [${dc.status}] ===`);
if (dc.ok) {
  console.log(`  dataSource            : ${dcJ.dataSource}`);
  console.log(`  state                 : ${dcJ.state}`);
  console.log(`  aclEnabled            : ${dcJ.aclEnabled ?? '(unset)'}`);
  console.log(`  identityRefreshInterval: ${JSON.stringify(dcJ.identityRefreshInterval ?? null)}`);
  console.log(`  identityScheduleConfig : ${JSON.stringify(dcJ.identityScheduleConfig ?? null)}`);
  console.log(`  entities              : ${(dcJ.entities ?? []).map((e: any) => e.entityName).join(', ') || '(none)'}`);
} else {
  console.log(`  ${JSON.stringify(dcJ).slice(0, 200)}`);
}

// 3. Any SharePoint-ish data stores, and whether they carry ACLs
const ds = await fetch(`${base}/collections/default_collection/dataStores?pageSize=100`, { headers: h });
const dsJ = await ds.json() as { dataStores?: Array<Record<string, any>> };
console.log(`\n=== data stores with ACL info ===`);
let aclCount = 0;
for (const d of dsJ.dataStores ?? []) {
  const id = String(d.name).split('/').pop();
  if (d.aclEnabled || d.identityMappingStore) {
    aclCount++;
    console.log(`  ${id}: aclEnabled=${d.aclEnabled} identityMappingStore=${d.identityMappingStore ?? '-'}`);
  }
}
console.log(`  ${aclCount} of ${(dsJ.dataStores ?? []).length} store(s) are ACL-enabled`);
