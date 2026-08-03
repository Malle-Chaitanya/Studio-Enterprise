/** Print the full source instructions text for a named agent. Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const NAME_MATCH = (process.argv[2] || 'CS_GE Knowledge Test Agent').toLowerCase();

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots;
    try { bots = await listBots(env.url, token); } catch { continue; }
    const bot = bots.find((b) => b.name.toLowerCase().includes(NAME_MATCH));
    if (!bot) continue;
    const ir = await extractAgent(env.url, token, bot);
    console.log(`agent: ${bot.name}\n`);
    console.log('--- FULL INSTRUCTIONS ---');
    console.log(ir.instructions ?? '(none)');
    console.log('\n--- KNOWLEDGE SOURCES ---');
    for (const k of ir.knowledgeSources) console.log(`- ${k.name} (${k.kind})${k.description ? ' — ' + k.description : ''}`);
    process.exit(0);
  }
  throw new Error('agent not found');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
