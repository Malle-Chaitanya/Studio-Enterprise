import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const r = await getDb()
    .collection('migrationResults')
    .find({ created: true })
    .sort({ $natural: -1 })
    .limit(5)
    .toArray();
  console.log('CREATED_AGENTS:', JSON.stringify(r.map((x: any) => ({
    name: x.name,
    agentId: x.agentId,
    geminiProject: x.geminiProject,
    deployed: x.deployed,
    updatedAt: x.updatedAt,
  })), null, 2));
  process.exit(0);
}
main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
