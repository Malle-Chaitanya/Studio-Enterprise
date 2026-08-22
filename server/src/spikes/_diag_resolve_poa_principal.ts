import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  return { status: res.status, text: await res.text() };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    const u = await dvGet(env.url, token, `systemusers(fc3c36a0-2992-f111-b8db-0022480b19e9)?$select=fullname,internalemailaddress`);
    if (u.status === 200) { console.log('Resolved as systemuser:', u.text); process.exit(0); }
    const t = await dvGet(env.url, token, `teams(fc3c36a0-2992-f111-b8db-0022480b19e9)?$select=name,teamtype`);
    if (t.status === 200) { console.log('Resolved as team:', t.text); process.exit(0); }
    console.log('user lookup:', u.status, u.text.slice(0,200));
    console.log('team lookup:', t.status, t.text.slice(0,200));
    process.exit(0);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
