import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent, resolveSystemUserEmail } from '../services/dataverse.js';
import { findCandidates } from '../services/graphSearch.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  for (const env of s.environments ?? []) {
    let dvToken: string;
    try {
      dvToken = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    let bots;
    try {
      bots = await listBots(env.url, dvToken);
    } catch {
      continue;
    }

    for (const bot of bots) {
      const ir = await extractAgent(env.url, dvToken, bot);
      const targets = ir.knowledgeSources.filter((k) => k.kind === 'FederatedStructuredSearchSource');
      if (!targets.length) continue;

      console.log(`\n=== ${bot.name} (env: ${env.name}) ===`);
      const graphToken = await clientCredsToken(s.tenantId ?? '', 'https://graph.microsoft.com');

      for (const src of targets) {
        console.log(`\n  source "${src.name}"  modifiedByUserId=${src.metadata?.modifiedByUserId ?? 'MISSING'}`);
        let email: string | null = null;
        if (src.metadata?.modifiedByUserId) {
          email = await resolveSystemUserEmail(env.url, dvToken, src.metadata.modifiedByUserId);
        }
        console.log(`  resolved email: ${email ?? 'NONE'}`);
        if (!email) {
          console.log('  -> skipping search (no owner email resolved)');
          continue;
        }
        const candidates = await findCandidates(graphToken, src.name, { oneDriveOwnerEmail: email });
        console.log(`  -> Graph search returned ${candidates.length} candidate(s):`);
        for (const c of candidates) {
          console.log(`     - "${c.name}" (${c.sizeBytes ?? '?'} bytes) driveId=${c.driveId} itemId=${c.itemId} context=${c.parentContext}`);
        }
      }
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
