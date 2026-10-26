import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { listCatalogOperations } from '../db/repos/connectorCatalog.js';
import { bindFromCatalog } from '../connectors/catalogBinding.js';

await connectMongo();
const ops = await listCatalogOperations('shared_googlecalendar');
for (const op of ops) {
  console.log(op.operationKey, '|', op.lifecycle.status, '|', op.sourceOperationIds.join(','));
}

console.log('\n--- bind check: DeleteEvent ---');
console.log(JSON.stringify(await bindFromCatalog('shared_googlecalendar', 'DeleteEvent'), null, 2));

console.log('\n--- bind check: UpdateEvent ---');
console.log(JSON.stringify(await bindFromCatalog('shared_googlecalendar', 'UpdateEvent'), null, 2));
process.exit(0);
