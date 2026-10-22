import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { listCatalogOperations } from '../db/repos/connectorCatalog.js';

await connectMongo();
const ops = await listCatalogOperations('shared_googledrive');
for (const op of ops) {
  if (op.chain) {
    console.log(`\n${op.operationKey} (${op.sourceOperationIds.join(',')}): ${op.chain.length} chain step(s)`);
    console.log(JSON.stringify(op.chain, null, 2));
  }
}
process.exit(0);
