import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { readAgentPermissions } from '../services/dataverse.js';

const MIGRATE_ADVISOR_BOT_ID = 'bdf9b817-9b90-f111-b8da-0022480b1f83';
const ACCESS_TEAM_ID = '3141652b-9b90-f111-b8da-0022480b19e9';
const THIRD_USER_EMAIL = 'ben@filefuze.co';

async function dvFetch(url: string, token: string, path: string, method = 'GET', body?: unknown) {
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

    const users = JSON.parse((await dvFetch(env.url, token, `systemusers?$select=systemuserid&$filter=internalemailaddress eq '${THIRD_USER_EMAIL}'`)).text) as { value: { systemuserid: string }[] };
    const thirdUserId = users.value[0]?.systemuserid;
    if (!thirdUserId) throw new Error('ben not found');

    console.log('--- Adding ben to the SAME access team as a second member (simulating a delegated re-share) ---');
    const add = await dvFetch(env.url, token, `teams(${ACCESS_TEAM_ID})/teammembership_association/$ref`, 'POST', {
      '@odata.id': `${env.url}/api/data/v9.2/systemusers(${thirdUserId})`,
    });
    console.log(add.status, add.text.slice(0, 300));

    console.log('\n--- readAgentPermissions AFTER adding the second member ---');
    console.log(JSON.stringify(await readAgentPermissions(env.url, token, MIGRATE_ADVISOR_BOT_ID), null, 2));

    console.log('\n--- Cleanup: removing ben from the team again ---');
    const remove = await dvFetch(env.url, token, `teams(${ACCESS_TEAM_ID})/teammembership_association(${thirdUserId})/$ref`, 'DELETE');
    console.log(remove.status);
    process.exit(0);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
