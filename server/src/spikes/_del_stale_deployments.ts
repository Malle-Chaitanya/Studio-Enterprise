/** Drop adkDeployments rows whose agent no longer exists. Destructive — --apply. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
const DELETED = ['17097469732904675895','17993371513859605249','18151362272469163166','5303788069228038400','5795553463369065960','8549215033884005992'];
const APPLY = process.argv.includes('--apply');
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);
const q = { agentId: { $in: DELETED } };
console.log(`matching rows: ${await db.collection('adkDeployments').countDocuments(q)}`);
if (APPLY) console.log(`deleted: ${(await db.collection('adkDeployments').deleteMany(q)).deletedCount}`);
else console.log('(dry run — pass --apply)');
await c.close(); process.exit(0);
