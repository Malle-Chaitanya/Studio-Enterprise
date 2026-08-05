// Clears the cached ADK deployment + drift snapshot for KB-Grounding-Test-Agent
// so the next migration run deploys fresh with the fixed adk_deploy.py
// requirements (google-cloud-discoveryengine) — otherwise drift detection
// would correctly (but unhelpfully here) see no source change and skip.
//   npx tsx src/spikes/_diag_clear_for_redeploy.ts
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const SOURCE_ID = '124794af-3b8f-f111-b8da-0022480b1f83';

async function main() {
  const client = new MongoClient(process.env.MONGO_HOST || 'mongodb://localhost:27019');
  await client.connect();
  const db = client.db(process.env.CSGE_DB || 'csge');

  const dep = await db.collection('adkDeployments').findOneAndDelete({ sourceId: SOURCE_ID });
  console.log('cleared adkDeployments:', dep ? JSON.stringify({ agentId: dep.agentId, reasoningEngine: dep.reasoningEngine }) : 'none found');

  const snap = await db.collection('migratedAgentSnapshots').deleteMany({ sourceId: SOURCE_ID });
  console.log('cleared migratedAgentSnapshots:', snap.deletedCount, 'record(s)');

  await client.close();

  if (dep) {
    console.log(`\nOnce redeployed, clean up the broken reasoning engine manually:`);
    console.log(`gcloud ai reasoning-engines delete ${dep.reasoningEngine.split('/').pop()} --project=231705905417 --region=us-central1`);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
