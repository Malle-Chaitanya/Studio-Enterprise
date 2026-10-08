/** Which service account does the Gmail connector credential actually hold? */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';

const ID = 'studio-enterprise-6a7168dfc40369e8807f5cc3-shared-googledrive-service-account-json';
const own = JSON.parse(config.GOOGLE_SA_KEY_JSON || readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8')) as any;
console.log(`app's own SA:      ${own.client_email}  client_id=${own.client_id}`);

const r = await getEntraSecret(await getSaToken(), `projects/agentmigrations/secrets/${ID}/versions/latest`);
if (!r.ok) { console.log('connector SA: could not read: ' + String((r as any).error).slice(0, 140)); process.exit(0); }
const conn = JSON.parse(r.plaintext!) as any;
console.log(`connector SA key:  ${conn.client_email}  client_id=${conn.client_id}`);
console.log(conn.client_id === own.client_id ? '\nSAME service account' : '\nDIFFERENT service account — DWD is authorized per CLIENT ID, so a grant for one does not cover the other.');
process.exit(0);
