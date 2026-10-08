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
/**
 * Three outcomes, not two. Google refuses an impersonated token two very different ways and
 * this probe reported both as "scope missing", which sent us to the wrong admin console
 * twice:
 *
 *   unauthorized_client   the scope is not in this domain's DWD grant   -> add the scope
 *   invalid_grant         the SUBJECT cannot be resolved at all         -> wrong address,
 *                         or the domain has no Workspace / no grant        or wrong domain
 */
type Outcome = 'granted' | 'scope-not-granted' | 'no-such-user';
async function probe(subject: string, scopes: string[]): Promise<Outcome> {
  try {
    const c = new JWT({ email: key.client_email, key: key.private_key, scopes, subject });
    return (await c.authorize()).access_token ? 'granted' : 'scope-not-granted';
  } catch (e) {
    return /invalid_grant/i.test((e as Error).message) ? 'no-such-user' : 'scope-not-granted';
  }
}
async function ok(subject: string, scopes: string[]) {
  return (await probe(subject, scopes)) === 'granted';
}
for (const subject of (process.env.CSGE_SUBJECTS ?? 'zara@storefuze.com,admin@migrationn.com').split(',')) {
  console.log(`=== ${subject} ===`);
  // Resolve the SUBJECT first. Without this, a mistyped address or a domain with no grant
  // prints five "missing scope" lines and sends someone to add scopes that are not the problem.
  const base = await probe(subject, ['https://www.googleapis.com/auth/drive.readonly']);
  if (base === 'no-such-user') {
    console.log('  NO SUCH USER — this address cannot be impersonated. Either it is wrong, or');
    console.log('  its domain has no Workspace / no domain-wide delegation for this service account.');
    continue;
  }
  for (const s of PENDING) {
    const o = await probe(subject, [s]);
    console.log(`  ${o === 'granted' ? 'GRANTED ' : 'MISSING '} ${s}`);
  }
  console.log(`  combined 17-scope request: ${(await ok(subject, WANTED)) ? 'OK — safe to widen ALL_SCOPES' : 'FAILS — do not widen yet'}`);
}
process.exit(0);
