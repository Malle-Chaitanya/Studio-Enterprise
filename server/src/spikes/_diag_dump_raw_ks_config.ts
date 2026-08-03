/**
 * Dump the raw Dataverse config for one or more knowledge sources on a named
 * test agent — used to discover the real `kind` string Copilot Studio writes
 * for a given knowledge source type (e.g. "public website") so a
 * knowledgeClassifier.ts rule can be written for it.
 *
 *   npx tsx src/_diag_dump_raw_ks_config.ts "CS_GE Knowledge Test Agent"
 *   npx tsx src/_diag_dump_raw_ks_config.ts "CS_GE Knowledge Test Agent" "Test Public Website"
 *
 * With no second argument, dumps every knowledge source found on the agent.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const NAME_MATCH = process.argv[2] || 'CS_GE Knowledge Test Agent';
const TARGETS = process.argv[3] ? process.argv.slice(3) : null;

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

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
    const bot = bots.find((b) => b.name === NAME_MATCH);
    if (!bot) continue;

    const ir = await extractAgent(env.url, token, bot);
    if (!ir.knowledgeSources.length) {
      console.log(`agent "${NAME_MATCH}" found but has no knowledge sources`);
      process.exit(0);
    }
    for (const k of ir.knowledgeSources) {
      if (TARGETS && !TARGETS.includes(k.name)) continue;
      console.log(`\n=== "${k.name}" (kind=${k.kind}) ===`);
      console.log('references:', JSON.stringify(k.references));
      console.log('classification:', JSON.stringify(k.classification, null, 2));
      console.log('FULL raw config:');
      console.log(JSON.stringify(k.raw, null, 2));
    }
    process.exit(0);
  }
  throw new Error(`agent "${NAME_MATCH}" not found in any connected environment`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
