import 'dotenv/config';
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const query = {
    appUserId: '6a5dfdff7cf05623332758b7',
    envUrl: 'https://org32322095.crm.dynamics.com',
    sourceId: 'bdf9b817-9b90-f111-b8da-0022480b1f83',
    project: '231705905417',
    engine: 'gemini-enterprise-17847887_1784788734248',
  };
  const d1 = await db.collection('adkDeployments').deleteOne(query);
  console.log('adkDeployments deletedCount:', d1.deletedCount);
  const d2 = await db.collection('migratedAgentSnapshots').deleteOne(query);
  console.log('migratedAgentSnapshots deletedCount:', d2.deletedCount);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
