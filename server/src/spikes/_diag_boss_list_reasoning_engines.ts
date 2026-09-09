import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = process.env.ADK_LOCATION || 'us-central1';

async function main() {
  const token = await getSaToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines`;
  console.log('Calling:', url);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log('HTTP status:', res.status);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { console.log('Non-JSON body:', text.slice(0, 500)); process.exit(1); }
  const engines = (json.reasoningEngines ?? []);
  console.log(`Found ${engines.length} reasoning engine(s):\n`);
  for (const e of engines) {
    console.log(`- name: ${e.name}`);
    console.log(`  displayName: ${e.displayName}`);
    console.log(`  createTime: ${e.createTime}`);
    console.log(`  updateTime: ${e.updateTime}`);
    console.log('');
  }
  if (!engines.length) console.log(JSON.stringify(json, null, 2).slice(0, 2000));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
