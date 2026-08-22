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

    console.log('--- Team record itself (teamtype: 0=Owner, 1=Access) ---');
    const team = await dvGet(env.url, token, `teams(${TEAM_ID})?$select=name,teamtype,isdefault`);
    console.log(team.status, team.text);

    console.log('\n--- Team membership ---');
    const members = await dvGet(env.url, token, `teams(${TEAM_ID})/teammembership_association?$select=systemuserid,fullname,internalemailaddress`);
    console.log(members.status, members.text);
    process.exit(0);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
