import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;
async function main() {
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}` };
  const r = await fetch(BASE, { headers: h });
  const json = await r.json();
  console.log(`status: ${r.status}`);
  console.log(JSON.stringify(json, null, 2).slice(0, 4000));
}
main().catch((e) => console.error(e.message));
