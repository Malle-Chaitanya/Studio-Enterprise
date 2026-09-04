/** Was Deal Desk ever actually migrated (staged/created on the Gemini side) via this
 *  project's real pipeline, as opposed to the read-only extraction probes run this session?
 *  npx tsx src/spikes/_diag_check_dealdesk_migrated.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();

const staged = await db.collection('stagedAgents').find({ name: /deal desk/i }).toArray();
console.log(`stagedAgents matching "deal desk": ${staged.length}`);
for (const s of staged) console.log(`  - ${s.name} (appUserId=${s.appUserId}, staged=${s.stagedAt ?? 'n/a'})`);

const results = await db.collection('migrationResults').find({ name: /deal desk/i }).toArray();
console.log(`\nmigrationResults matching "deal desk": ${results.length}`);
for (const r of results) console.log(`  - ${r.name} deployed=${r.deployed} shared=${r.shared} verified=${r.verified} geminiAgentId=${r.geminiAgentId ?? 'n/a'}`);

process.exit(0);
