/**
 * Dump the stored migrationResults doc for one bot in one run — the
 * authoritative fidelity record (mapped/partial/lost per knowledge source),
 * as opposed to reading console log lines.
 *
 *   npx tsx src/spikes/_dump_migration_result.ts <runId> "<bot name>"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

const runId = process.argv[2];
const botName = process.argv[3];

async function main() {
  await connectMongo();
  const doc = await getDb(config.CSGE_DB).collection('migrationResults').findOne(
    { runId, ...(botName ? { name: botName } : {}) },
  );
  if (!doc) {
    console.log(`no migrationResults doc found for runId=${runId} name=${botName ?? '(any)'}`);
    const any = await getDb(config.CSGE_DB).collection('migrationResults').find({ runId }).toArray();
    console.log(`docs found for this runId (any name): ${any.length}`);
    for (const d of any) console.log(' -', d.name);
    process.exit(0);
  }
  console.log(JSON.stringify(doc, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
