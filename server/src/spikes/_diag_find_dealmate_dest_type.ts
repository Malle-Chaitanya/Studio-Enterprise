/** Find the current destination Gemini agent for this session's appUserId and report
 *  whether it is a low-code agent (patchable instruction, no redeploy) or an ADK agent
 *  (Reasoning Engine, needs redeploy). Read-only.
 *  npx tsx src/spikes/_diag_find_dealmate_dest_type.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const appUserId = '6a5dfdff7cf05623332758b7';

  const result = await getDb()
    .collection('migrationResults')
    .find({ appUserId })
    .sort({ $natural: -1 })
    .limit(5)
    .toArray();

  console.log(`Found ${result.length} recent migrationResults for appUserId ${appUserId}\n`);
  for (const r of result as any[]) {
    console.log(`name=${r.name} geminiAgentId=${r.geminiAgentId} created=${r.created}`);
  }

  const adk = await getDb().collection('adkDeployments').find({ appUserId }).sort({ $natural: -1 }).limit(5).toArray();
  console.log(`\nadkDeployments records for this appUserId: ${adk.length}`);
  for (const a of adk as any[]) {
    console.log(JSON.stringify(a, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
