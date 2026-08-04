import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const NAMES = ['Sales Opportunity Agent', 'Sales Qualification Agent Config Assistant', 'Service Operations Agent', 'D365 Sales - Data Enrichment'];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ geminiProject: '231705905417' }).next()) as Session | null;
  if (!s) throw new Error('no session for 231705905417');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots;
    try { bots = await listBots(env.url, token); } catch { continue; }

    for (const name of NAMES) {
      const bot = bots.find((b) => b.name === name);
      if (!bot) continue;
      const ir = await extractAgent(env.url, token, bot);
      const files = ir.knowledgeSources.filter((k) => k.kind === 'FileUpload');
      console.log(`\n"${name}" (env: ${env.url}) — ${files.length} FileUpload source(s) in SOURCE:`);
      for (const f of files) console.log(`  - ${f.file?.name ?? f.name}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
