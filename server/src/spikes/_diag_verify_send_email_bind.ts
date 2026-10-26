import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { bindFromCatalog } from '../connectors/catalogBinding.js';

await connectMongo();
const result = await bindFromCatalog('shared_gmail', 'SendEmailV2');
console.log(JSON.stringify(result, null, 2));
process.exit(0);
