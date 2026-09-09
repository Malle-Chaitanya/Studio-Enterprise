import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-central1';

async function main() {
  const token = await getSaToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  const engines = json.reasoningEngines ?? [];
  console.log(`Found ${engines.length} reasoning engine(s) total:\n`);
  for (const e of engines) {
    console.log(`- ${e.displayName}  (${e.name.split('/').pop()})  created=${e.createTime}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
