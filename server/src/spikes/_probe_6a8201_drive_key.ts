/** What EXACTLY is stored in this run's Google service-account secret. Prints shape and
 *  identity fields only — never the private key. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
const ID = process.env.SECRET_ID || 'studio-enterprise-6a8201ef3adc2441618a9179-shared-googledrive-service-account-json';
const token = await getSaToken();
for (const project of ['agentmigrations', 'studio-enterprise-migration']) {
  const r = await getEntraSecret(token, `projects/${project}/secrets/${ID}/versions/latest`);
  if (!r.ok || !r.plaintext) { console.log(`${project}: UNREADABLE ${String((r as {error?:string}).error).slice(0,120)}`); continue; }
  const p = r.plaintext;
  console.log(`\n${project}: ${p.length} chars, starts: ${JSON.stringify(p.slice(0, 46))}`);
  try {
    const k = JSON.parse(p) as { client_email?: string; client_id?: string; type?: string };
    console.log(`  parsed OK  type=${k.type} client_email=${k.client_email} client_id=${k.client_id}`);
  } catch (e) {
    console.log(`  JSON.parse FAILED: ${(e as Error).message.slice(0, 120)}`);
  }
}
process.exit(0);
