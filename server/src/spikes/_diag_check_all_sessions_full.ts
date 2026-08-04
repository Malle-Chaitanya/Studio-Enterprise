import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const sessions = await getDb().collection('migrationSessions').find({}).toArray();
  for (const s of sessions) {
    console.log(JSON.stringify({
      geminiProject: s.geminiProject,
      gEmail: s.gEmail,
      tenantId: s.tenantId,
      environments: (s.environments ?? []).map((e: { url?: string }) => e.url),
    }));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
