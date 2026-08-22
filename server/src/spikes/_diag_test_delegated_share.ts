/** Tests whether a SECOND, independent share on the same bot (simulating "the person
 *  the admin shared it with then re-shares it to someone else") is captured by the same
 *  fetch mechanism just fixed — POA is keyed by objectid (the record), not by who
 *  performed the share, so structurally it SHOULD show up the same way. This verifies
 *  that empirically instead of assuming it.
 *   npx tsx src/spikes/_diag_test_delegated_share.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { readAgentPermissions } from '../services/dataverse.js';

const MIGRATE_ADVISOR_BOT_ID = 'bdf9b817-9b90-f111-b8da-0022480b1f83';
const THIRD_PRINCIPAL_EMAIL = 'ben@filefuze.co'; // reused known systemuser as the "re-shared to" target

async function dvGet(url: string, token: string, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  for (const env of s.environments ?? []) {
    if (env.name !== 'CloudFuze Agent Migration Hub') continue;
    const token = await clientCredsToken(s.tenantId ?? '', env.url);

    console.log('--- BEFORE: current shares on Migrate Advisor ---');
    console.log(JSON.stringify(await readAgentPermissions(env.url, token, MIGRATE_ADVISOR_BOT_ID), null, 2));

    console.log('\n--- Attempting GrantAccess (bound action, write side) ---');
    const users = JSON.parse((await dvGet(env.url, token, `systemusers?$select=systemuserid&$filter=internalemailaddress eq '${THIRD_PRINCIPAL_EMAIL}'`)).text) as { value: { systemuserid: string }[] };
    const thirdUserId = users.value[0]?.systemuserid;
    if (!thirdUserId) { console.log('third user not found'); process.exit(1); }

    const grant = await dvGet(env.url, token, `bots(${MIGRATE_ADVISOR_BOT_ID})/Microsoft.Dynamics.CRM.GrantAccess`, 'POST', {
      PrincipalAccess: {
        Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: thirdUserId },
        AccessMask: 'ReadAccess',
      },
    });
    console.log('GrantAccess ->', grant.status, grant.text.slice(0, 500));

    console.log('\n--- AFTER: shares on Migrate Advisor (does the fetch pick up the new one too?) ---');
    console.log(JSON.stringify(await readAgentPermissions(env.url, token, MIGRATE_ADVISOR_BOT_ID), null, 2));
    process.exit(0);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
