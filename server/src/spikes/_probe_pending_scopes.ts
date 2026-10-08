/** Are the five NEW Google scopes in the DWD grant yet? Exact strings only - a grant matches
 *  scope strings literally, so `tasks` does not imply `tasks.readonly`. Throwaway. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config, ALL_SCOPES } from '../config.js';
const key = JSON.parse(config.GOOGLE_SA_KEY_JSON || readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8'));
const PENDING = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/forms.body',
];
const WANTED = [...ALL_SCOPES, ...PENDING];
async function ok(subject: string, scopes: string[]) {
  try {
    const c = new JWT({ email: key.client_email, key: key.private_key, scopes, subject });
    return Boolean((await c.authorize()).access_token);
  } catch { return false; }
}
for (const subject of (process.env.CSGE_SUBJECTS ?? 'zara@storefuze.com,admin@migrationn.com').split(',')) {
  console.log(`=== ${subject} ===`);
  for (const s of PENDING) console.log(`  ${(await ok(subject, [s])) ? 'GRANTED ' : 'MISSING '} ${s}`);
  console.log(`  combined 17-scope request: ${(await ok(subject, WANTED)) ? 'OK — safe to widen ALL_SCOPES' : 'FAILS — do not widen yet'}`);
}
process.exit(0);
