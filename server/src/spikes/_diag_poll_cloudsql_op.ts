/** Poll the Cloud SQL instance-creation operation until DONE.
 *  npx tsx src/spikes/_diag_poll_cloudsql_op.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const OP = 'f13a336b-b9b0-4190-97b2-a77a00000032';

for (let i = 0; i < 40; i++) {
  const saToken = await getSaToken();
  const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/operations/${OP}`, {
    headers: { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': PROJECT },
  });
  const json = (await res.json()) as { status?: string; error?: unknown };
  console.log(`[${new Date().toISOString()}] status: ${json.status}`);
  if (json.status === 'DONE') {
    console.log(JSON.stringify(json, null, 2).slice(0, 1000));
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
console.log('gave up after ~10 minutes');
process.exit(1);
