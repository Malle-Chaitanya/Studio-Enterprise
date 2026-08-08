import 'dotenv/config';
import { connectDb } from '../db/core.js';
import { config } from '../config.js';
import { runPendingGroundingRechecks } from '../services/groundingRecheck.js';

async function main() {
  await connectDb(config.CSGE_DB);
  await runPendingGroundingRechecks();
  console.log('sweep ran with no throw.');
}
main().catch((e) => console.error('FAILED:', e.message));
