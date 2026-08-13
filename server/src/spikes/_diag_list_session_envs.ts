/** List cached environment URLs from the latest migration session, to feed into other diag scripts. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';

const mc = await MongoClient.connect(config.MONGO_HOST, { serverSelectionTimeoutMS: 5000 });
const count = await mc.db(config.CSGE_DB).collection('migrationSessions').countDocuments({});
console.log('session count:', count);
const docs = await mc
  .db(config.CSGE_DB)
  .collection('migrationSessions')
  .find({})
  .sort({ $natural: -1 })
  .limit(5)
  .toArray();
for (const d of docs) {
  console.log(JSON.stringify({ appUserId: d.appUserId, tenantId: d.tenantId, environments: d.environments, geminiProject: d.geminiProject }, null, 2));
}
await mc.close();
process.exit(0);
