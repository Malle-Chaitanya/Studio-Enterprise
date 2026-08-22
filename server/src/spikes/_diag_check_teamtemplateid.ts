/** Verifies two claims from external analysis before trusting either:
 *  1. Does the "bdf9b8179b90f111b8da0022480b1f83_1" team have a teamtemplateid set
 *     (the documented signal for an Access-Team-Template-generated team)?
 *  2. Does RetrieveSharedPrincipalsAndAccess() also 404 on a genuine out-of-box entity
 *     in this same org, or only on `bot`? (tests whether the 404 is a generic
 *     custom-entity limitation vs. something bot-specific.)
 *   npx tsx src/spikes/_diag_check_teamtemplateid.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const TEAM_ID = '3141652b-9b90-f111-b8da-0022480b19e9';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  return { status: res.status, text: await res.text() };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  for (const env of s.environments ?? []) {
    if (env.name !== 'CloudFuze Agent Migration Hub') continue;
    const token = await clientCredsToken(s.tenantId ?? '', env.url);

    console.log('--- 1. teamtemplateid on the access team ---');
    const team = await dvGet(env.url, token, `teams(${TEAM_ID})?$select=name,teamtype,_teamtemplateid_value`);
    console.log(team.status, team.text);

    console.log('\n--- 2. Does the bound function exist/work on a genuine OOB entity (accounts)? ---');
    const accounts = await dvGet(env.url, token, `accounts?$select=accountid&$top=1`);
    console.log('accounts probe:', accounts.status, accounts.text.slice(0, 200));
    if (accounts.status === 200) {
      const parsed = JSON.parse(accounts.text) as { value: { accountid: string }[] };
      const acctId = parsed.value[0]?.accountid;
      if (acctId) {
        const fn = await dvGet(env.url, token, `accounts(${acctId})/Microsoft.Dynamics.CRM.RetrieveSharedPrincipalsAndAccess()`);
        console.log(`RetrieveSharedPrincipalsAndAccess() on accounts(${acctId}):`, fn.status, fn.text.slice(0, 300));
      } else {
        console.log('No account records exist to test against.');
      }
    }
    process.exit(0);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
