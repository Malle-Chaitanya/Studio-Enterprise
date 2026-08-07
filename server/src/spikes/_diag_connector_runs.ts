/** Why did the SharePoint connector index 0 documents? Read its sync runs.
 *  connectorRuns requires the project NUMBER in the resource name, not the id.
 *  npx tsx src/spikes/_diag_connector_runs.ts [collectionId] */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const COL = process.argv[2] ?? 'connectortest_1785961359928';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}` };
const pn = (await (await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${P}`, { headers: h })).json() as { projectNumber?: string }).projectNumber;
const base = `${HOST}/projects/${pn}/locations/global/collections/${COL}/dataConnector`;
const r = await fetch(`${base}/connectorRuns`, { headers: h });
const text = await r.text();
if (!r.ok) { console.log(`connectorRuns [${r.status}]: ${text.replace(/\s+/g, ' ').slice(0, 300)}`); process.exit(0); }
const j = JSON.parse(text) as { connectorRuns?: Array<Record<string, any>> };
console.log(`${(j.connectorRuns ?? []).length} run(s)\n`);
for (const run of (j.connectorRuns ?? []).slice(0, 3)) {
  console.log(`── ${String(run.name).split('/').pop()}  state=${run.state}  start=${run.startTime} end=${run.endTime ?? '-'}`);
  for (const e of run.entityRuns ?? []) {
    console.log(`   entity=${e.entityName} state=${e.state} extracted=${e.extractedRecordCount ?? 0} indexed=${e.indexedRecordCount ?? 0} errors=${e.errorRecordCount ?? 0}`);
    for (const err of (e.errors ?? []).slice(0, 2)) console.log(`     ERROR ${JSON.stringify(err).slice(0, 350)}`);
  }
  for (const err of (run.errors ?? []).slice(0, 2)) console.log(`   RUN ERROR ${JSON.stringify(err).slice(0, 350)}`);
  console.log('');
}
