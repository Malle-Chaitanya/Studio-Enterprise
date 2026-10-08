/** Can the SA (own) and the DWD caller read the Google SA-key secret, in each project? */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
const ID = process.env.SECRET_ID || 'studio-enterprise-6a7168dfc40369e8807f5cc3-shared-googledrive-service-account-json';
for (const [label, tok] of [['SA own', await getSaToken()], ['DWD admin@migrationn.com', await getSaToken('admin@migrationn.com')]] as const) {
  for (const project of ['studio-enterprise-migration', 'agentmigrations']) {
    const r = await getEntraSecret(tok, `projects/${project}/secrets/${ID}/versions/latest`);
    console.log(`${label.padEnd(26)} ${project.padEnd(30)} ${r.ok ? 'OK' : 'FAIL ' + String((r as { error?: string }).error).replace(/\s+/g,' ').slice(0, 90)}`);
  }
}
process.exit(0);
