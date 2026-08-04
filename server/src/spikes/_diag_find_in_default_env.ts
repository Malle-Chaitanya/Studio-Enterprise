/** Read-only: list bots in the tenant's default environment, find one matching a name. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const NAME_MATCH = (process.argv[2] || 'cloudfuze studio migrate').toLowerCase();

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const env = (s.environments ?? []).find((e) => e.name.toLowerCase().includes('default') || String(e.id ?? '').toLowerCase().startsWith('default-'));
  if (!env) throw new Error('no default environment on this session');
  console.log(`default environment: ${env.name}  (${env.url})`);
  const token = await clientCredsToken(s.tenantId ?? '', env.url);
  const bots = await listBots(env.url, token);
  console.log(`${bots.length} agent(s) total\n`);
  const matches = bots.filter((b) => b.name.toLowerCase().includes(NAME_MATCH));
  if (matches.length) {
    console.log(`MATCHES for "${NAME_MATCH}":`);
    for (const m of matches) console.log(`  - "${m.name}"  botid=${m.botid}`);
  } else {
    console.log(`no match for "${NAME_MATCH}". First 20 agent names in this environment:`);
    for (const b of bots.slice(0, 20)) console.log(`  - ${b.name}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
