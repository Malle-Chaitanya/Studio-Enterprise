/** Can the SA read the ms_graph secret trio in each project? (GetRateSheetBand authConfig blocker) */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

const BASE = 'studio-enterprise-6a7168dfc40369e8807f5cc3-ms-graph';
const IDS = { tenant_id: `${BASE}-tenant-id`, client_id: `${BASE}-client-id`, client_secret: `${BASE}-client-secret` };
const saToken = await getSaToken();

for (const project of ['studio-enterprise-migration', 'agentmigrations']) {
  console.log(`\n=== ${project} ===`);
  for (const [label, id] of Object.entries(IDS)) {
    const r = await getEntraSecret(saToken, `projects/${project}/secrets/${id}/versions/latest`);
    console.log(`  ${label.padEnd(14)} ${r.ok ? 'OK' : 'FAIL: ' + String((r as { error?: string }).error).slice(0, 150)}`);
  }
}
process.exit(0);
