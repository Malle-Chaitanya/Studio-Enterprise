/**
 * Read-only scan: find a source Copilot Studio agent that has BOTH real
 * instructions text AND a locally-uploaded file knowledge source (kind with
 * `file` set — not a SharePoint/OneDrive link). Used to pick a good candidate
 * for an end-to-end _test_migrate.ts run that exercises instruction + file
 * attachment fidelity, not just an agent with no knowledge at all.
 *
 *   npx tsx src/spikes/_diag_find_local_file_agent.ts [sessionId]
 *
 * Read-only: extraction only, no writes to Dataverse or Gemini.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const SESSION_ID = process.argv[2];

async function main() {
  await connectMongo();
  const s = (SESSION_ID
    ? await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as never })
    : await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()
  ) as Session | null;
  if (!s) throw new Error('no usable session found — pass a sessionId or connect via the web app first');

  console.log(`tenant=${s.orgName}  environments=${s.environments?.length ?? 0}\n`);

  let checked = 0;
  const CAP = 60; // don't hammer Dataverse — bounded scan across environments

  for (const env of s.environments ?? []) {
    if (checked >= CAP) break;
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch (e) {
      console.log(`  · ${env.name}: token failed (${(e as Error).message})`);
      continue;
    }
    let bots;
    try {
      bots = await listBots(env.url, token);
    } catch (e) {
      console.log(`  · ${env.name}: listBots failed (${(e as Error).message})`);
      continue;
    }
    console.log(`env "${env.name}": ${bots.length} agent(s)`);

    for (const bot of bots) {
      if (checked >= CAP) break;
      checked++;
      try {
        const ir = await extractAgent(env.url, token, bot);
        const fileSources = ir.knowledgeSources.filter((k) => k.file);
        const hasInstructions = !!ir.instructions && ir.instructions.trim().length > 0;
        if (hasInstructions && fileSources.length > 0) {
          console.log('\n' + '='.repeat(70));
          console.log('MATCH FOUND');
          console.log('='.repeat(70));
          console.log(`environment:  ${env.name}  (${env.url})`);
          console.log(`agent name:   ${bot.name}`);
          console.log(`agent botid:  ${bot.botid}`);
          console.log(`instructions: ${ir.instructions!.length} chars`);
          console.log(`file knowledge sources:`);
          for (const f of fileSources) {
            console.log(`  - "${f.name}" file=${f.file?.name ?? '?'} format=${f.file?.format ?? '?'} size=${f.file?.sizeBytes ?? '?'}B compatible=${f.file?.compatible}`);
          }
          console.log(`topics: ${ir.topics.length}  total knowledge sources: ${ir.knowledgeSources.length}`);
          console.log('='.repeat(70));
          process.exit(0);
        }
      } catch (e) {
        console.log(`  · ${bot.name}: extract failed (${(e as Error).message})`);
      }
    }
  }

  console.log(`\nNo agent with both instructions + a local file knowledge source found in ${checked} checked (cap ${CAP}).`);
  process.exit(1);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
