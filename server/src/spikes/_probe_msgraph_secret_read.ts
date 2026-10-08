/** Which of the ms_graph auth-config secrets the SA cannot read (the GetRateSheetBand blocker). */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { connectMongo } from '../db/mongo.js';
import { getConnectorCredential } from '../db/repos/connectorCredentials.js';
import { getEntraSecret } from '../services/secretManager.js';
import { CONNECTOR_REGISTRY } from '../connectors/registry.js';

const APP_USER = process.env.APP_USER_ID || '6a7168dfc40369e8807f5cc3';
const GROUP = process.env.GROUP || 'ms_graph';
await connectMongo();
const saToken = await getSaToken();

const candidates = CONNECTOR_REGISTRY.filter((d) => d.credentialGroup === GROUP || d.id === GROUP);
console.log(`candidates for "${GROUP}": ${candidates.map((c) => c.id).join(', ') || '(none)'}`);

for (const def of candidates) {
  const rec = await getConnectorCredential(APP_USER, def.id);
  if (!rec?.secretIds) { console.log(`  ${def.id}: no stored record`); continue; }
  const { tenant_id, client_id, client_secret } = rec.secretIds;
  if (!tenant_id || !client_id || !client_secret) { console.log(`  ${def.id}: incomplete secretIds`); continue; }
  console.log(`  ${def.id}: project=${rec.project}`);
  for (const [label, id] of Object.entries({ tenant_id, client_id, client_secret })) {
    const r = await getEntraSecret(saToken, `projects/${rec.project}/secrets/${id}/versions/latest`);
    console.log(`    ${label.padEnd(14)} ${id.padEnd(46)} ${r.ok ? 'OK' : 'FAIL: ' + String((r as any).error).slice(0, 160)}`);
  }
  break;
}
