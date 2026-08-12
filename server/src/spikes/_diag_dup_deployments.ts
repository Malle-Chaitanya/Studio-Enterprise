/** Why are there two deployment rows for one agent? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('adkDeployments').find({ sourceId: 'cd560e08-8e90-f111-8077-0022480a981d' }).toArray();
for (const r of rows as any[]) {
  console.log(JSON.stringify({ appUserId: r.appUserId, envUrl: r.envUrl, project: r.project, engine: r.engine, agentId: r.agentId, deployedAt: r.deployedAt }));
}
process.exit(0);
