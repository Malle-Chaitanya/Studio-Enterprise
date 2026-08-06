/** Which engines exist, and which of them host agents? npx tsx src/spikes/_diag_list_engines.ts */
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
const base = `${HOST}/projects/${P}/locations/global/collections/default_collection`;
const r = await fetch(`${base}/engines?pageSize=50`, { headers: h });
const j = await r.json() as { engines?: Array<{ name: string; displayName?: string; solutionType?: string; appType?: string; dataStoreIds?: string[] }> };
for (const e of j.engines ?? []) {
  const id = e.name.split('/').pop()!;
  const ar = await fetch(`${base}/engines/${id}/assistants/default_assistant/agents?pageSize=50`, { headers: h });
  const aj = await ar.json() as { agents?: Array<{ displayName?: string; state?: string }> };
  console.log(`\n${id}\n  display=${e.displayName}  solution=${e.solutionType} appType=${e.appType}`);
  console.log(`  dataStoreIds=${JSON.stringify(e.dataStoreIds ?? [])}`);
  console.log(`  agents[${ar.status}]=${(aj.agents ?? []).map(a => `${a.displayName}(${a.state})`).join(', ') || '(none)'}`);
}
