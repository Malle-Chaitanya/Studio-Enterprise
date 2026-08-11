import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const RUN_ID = 'N20TOhatrc-a6UqJZ-TtpKmAfxc';

async function main() {
  await connectMongo();
  const db = getDb();
  const logs = await db.collection('migrationLogs').find({ runId: RUN_ID }).sort({ $natural: 1 }).toArray();
  console.log(`found ${logs.length} log(s) for run ${RUN_ID}`);
  for (const l of logs as any[]) {
    const msg = String(l.msg ?? '');
    if (/hr policy|neutara|sharepoint|copy mode|connector/i.test(msg)) {
      console.log(`[${l.level}] ${msg}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
