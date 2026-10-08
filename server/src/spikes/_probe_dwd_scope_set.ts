/** Does the PRODUCTION DWD request succeed? getGoogleAccessToken asks for ALL_SCOPES in one
 *  JWT, and Google refuses the whole request if ANY scope is outside the Workspace admin's
 *  grant. Per-scope probing cannot see that; this asks the exact production question.
 *  Reports only. Never prints a token. Throwaway diagnostic. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config, ALL_SCOPES, SA_DIRECTORY_SCOPES } from '../config.js';

const subject = process.env.CSGE_IMPERSONATE;
if (!subject) { console.error('set CSGE_IMPERSONATE=<workspace user email>'); process.exit(2); }
const key = JSON.parse(config.GOOGLE_SA_KEY_JSON || readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8'));

async function probe(label: string, scopes: string[]) {
  try {
    const c = new JWT({ email: key.client_email, key: key.private_key, scopes, subject });
    const { access_token: t } = await c.authorize();
    console.log(`${label.padEnd(30)} OK    ${scopes.length} scope(s), token received`);
    return Boolean(t);
  } catch (e) {
    console.log(`${label.padEnd(30)} FAIL  ${(e as Error).message.split('\n')[0].slice(0, 64)}`);
    return false;
  }
}

console.log(`impersonating ${subject} via client id ${key.client_id}\n`);
await probe('ALL_SCOPES (production path)', ALL_SCOPES);
await probe('SA_DIRECTORY_SCOPES', SA_DIRECTORY_SCOPES);

// Narrow down WHICH scopes the grant actually covers, one at a time.
console.log('\nper-scope, from ALL_SCOPES:');
const granted: string[] = [];
for (const s of ALL_SCOPES) {
  const ok = await probe(`  ${s.replace('https://www.googleapis.com/auth/', '')}`, [s]);
  if (ok) granted.push(s);
}
console.log(`\ngranted ${granted.length}/${ALL_SCOPES.length}:`);
for (const g of granted) console.log('  ' + g);
process.exit(0);
