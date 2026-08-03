/**
 * Verify the embedded-config fix: run the REAL extractAgent() against
 * "Transformation PreCanned MIA" (the live test agent whose "Knowledge -
 * knowledgearticle" source was being silently misclassified as a broken
 * file) and print its resulting knowledgeSources + classification.
 *
 *   npx tsx src/spikes/_diag_verify_dv_extraction.ts ["name substring"] [sessionId]
 *
 * Touches Copilot Studio READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const NAME_MATCH = (process.argv[2] || 'transformation precanned').toLowerCase();
const SESSION_ID = process.argv[3];

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');

  for (const env of s.environments ?? []) {
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    let bots;
    try {
      bots = await listBots(env.url, token);
    } catch {
      continue;
    }
    const bot = bots.find((b) => b.name.toLowerCase().includes(NAME_MATCH));
    if (!bot) continue;

    console.log(`\n=== ${bot.name} (env: ${env.name}) ===`);
    const ir = await extractAgent(env.url, token, bot);
    for (const k of ir.knowledgeSources) {
      console.log(`\n  "${k.name}"  kind=${JSON.stringify(k.kind)}  refs=${JSON.stringify(k.references)}`);
      console.log(
        `    → strategy=${k.classification?.strategy} target=${k.classification?.geminiTarget} automatable=${k.classification?.automatable}`,
      );
    }
    process.exit(0);
  }
  throw new Error(`agent matching "${NAME_MATCH}" not found`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
