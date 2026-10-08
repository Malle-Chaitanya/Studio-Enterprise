/** Same secret reads, but with the DWD-impersonated token the run actually used. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

const BASE = 'studio-enterprise-6a7168dfc40369e8807f5cc3-ms-graph';
const IDS = { tenant_id: `${BASE}-tenant-id`, client_id: `${BASE}-client-id`, client_secret: `${BASE}-client-secret` };
const SUBJECT = process.env.SUBJECT || 'admin@migrationn.com';

for (const [label, tok] of [['SA own', await getSaToken()], ['DWD ' + SUBJECT, await getSaToken(SUBJECT)]] as const) {
  console.log(`\n=== ${label} ===`);
  for (const project of ['studio-enterprise-migration', 'agentmigrations']) {
    for (const [k, id] of Object.entries(IDS)) {
      const r = await getEntraSecret(tok, `projects/${project}/secrets/${id}/versions/latest`);
      console.log(`  ${project.padEnd(30)} ${k.padEnd(14)} ${r.ok ? 'OK' : 'FAIL: ' + String((r as { error?: string }).error).slice(0, 120)}`);
    }
  }
}
process.exit(0);
