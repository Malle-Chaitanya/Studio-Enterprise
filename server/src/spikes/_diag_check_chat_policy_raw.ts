/** Checks the RAW, unparsed accesscontrolpolicy + authorizedsecuritygroupids fields on
 *  both real bots we've been testing, to verify parseGroupIds()/decodeChatPolicy() are
 *  reading them correctly — chatAccess came back as {policy:"group", groupIds:[]} for both
 *  bots, which is internally inconsistent (a "group" policy with zero groups) unless the
 *  raw field is being mis-parsed, exactly like the POA/access-team gap just found for
 *  individual Editor shares.
 *   npx tsx src/spikes/_diag_check_chat_policy_raw.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const BOTS = {
  'Migrate Advisor': 'bdf9b817-9b90-f111-b8da-0022480b1f83',
  'Knowledge Assistant': 'ca57b355-d08b-f111-8076-0022480b19e9',
};

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

    for (const [name, id] of Object.entries(BOTS)) {
      console.log(`\n=== ${name} (${id}) ===`);
      const raw = await dvGet(
        env.url, token,
        `bots(${id})?$select=accesscontrolpolicy,authorizedsecuritygroupids,statecode,statuscode`,
      );
      console.log(raw.status, raw.text);
    }
    process.exit(0);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
