/** Does ensureAuthConfig now build the ms_graph AuthConfig with the DWD token? */
import 'dotenv/config';
import { connectDb } from '../db/core.js';
import { config } from '../config.js';
import { getSaToken } from '../auth/google.js';
import { ensureAuthConfig } from '../services/applicationIntegration.js';

await connectDb(config.CSGE_DB, 1, 500);   // no ensureCollections — read-only probe
const APP_USER = process.env.APP_USER_ID || '6a7168dfc40369e8807f5cc3';
const DEST = process.env.DEST_PROJECT || 'agentmigrations';

for (const subject of [undefined, 'admin@migrationn.com'] as const) {
  const tok = await getSaToken(subject);
  const res = await ensureAuthConfig(tok, DEST, APP_USER, 'ms_graph');
  console.log(`${(subject ?? 'SA own').padEnd(24)} -> ${res.ok ? 'OK' : 'FAIL: ' + res.error}`);
}
process.exit(0);
