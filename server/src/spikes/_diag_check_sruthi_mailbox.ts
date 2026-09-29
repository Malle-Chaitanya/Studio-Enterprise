/** Does sruthi.chimata@cloudfuze.com exist as a real mailbox in the SAME Microsoft
 *  tenant our app-only Graph credentials cover (the one behind the Copilot Studio
 *  test env)? If not, "send mail as Sruthi" via Graph app-only is not possible
 *  without a separate grant against cloudfuze.com's own tenant. Read-only.
 *  npx tsx src/spikes/_diag_check_sruthi_mailbox.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CANDIDATES = ['sruthi.chimata@cloudfuze.com', 'erik@filefuze.co', 'ben@filefuze.co'];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId) throw new Error('no tenantId on latest session');

  console.log(`Checking against tenant: ${s.tenantId}\n`);
  const token = await clientCredsToken(s.tenantId, 'https://graph.microsoft.com');

  for (const upn of CANDIDATES) {
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(upn)}?$select=id,userPrincipalName,mail,displayName`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    console.log(`${upn} -> ${res.status}`);
    console.log(`  ${body.slice(0, 300)}\n`);
  }

  // Also list verified domains on this tenant so we know what it CAN address.
  const domRes = await fetch(`${GRAPH}/domains?$select=id,isVerified`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('--- verified domains on this tenant ---');
  console.log((await domRes.text()).slice(0, 1000));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
