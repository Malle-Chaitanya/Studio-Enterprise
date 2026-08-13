/** Terminal logs only show WARN-level fidelity notes — success is silent by design.
 *  Check the actual migrationResults record for run MuvNQAqPThzVrrl70U-bnvqjWbE to
 *  see the real, complete fidelity outcome for every knowledge source, not just the
 *  gaps that happened to log.
 *  npx tsx src/spikes/_diag_check_run_fidelity.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const result = await getDb().collection('migrationResults').findOne({ runId: 'MuvNQAqPThzVrrl70U-bnvqjWbE' });
  if (!result) { console.log('NOT FOUND'); process.exit(1); }
  console.log(`name: ${result.name}, ok: ${result.ok}, error: ${result.error ?? '(none)'}`);
  console.log(`knowledgeFilesUploaded: ${result.knowledgeFilesUploaded}, knowledgeFilesFailed: ${result.knowledgeFilesFailed}`);
  console.log('\n--- fidelity notes ---');
  for (const f of result.fidelity ?? []) {
    console.log(`[${f.status}] ${f.component}: ${f.detail}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
