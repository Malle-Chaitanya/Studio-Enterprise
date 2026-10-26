import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { bindAlwaysOnOperations } from '../connectors/catalogBinding.js';

await connectMongo();

console.log('--- Drive always-on operations (expect create_file_by_path among them) ---');
const drive = await bindAlwaysOnOperations('shared_googledrive');
for (const d of drive) console.log(d.displayName, '|', d.operation.operationId, '| chain:', !!d.operation.chain);

console.log('\n--- Calendar always-on operations (expect get_current_datetime among them) ---');
const cal = await bindAlwaysOnOperations('shared_googlecalendar');
for (const c of cal) console.log(c.displayName, '|', c.operation.operationId, '| chain:', JSON.stringify(c.operation.chain));

process.exit(0);
