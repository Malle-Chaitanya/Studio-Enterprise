import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = '231705905417';
async function main() {
  const token = await getSaToken();
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/us-central1/reasoningEngines`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await r.json()) as { reasoningEngines?: { name: string; displayName: string; createTime: string }[] };
  const engines = (j.reasoningEngines || []).map((e) => ({ name: e.name, displayName: e.displayName, createTime: e.createTime }));
  console.log(JSON.stringify(engines, null, 2));
}
main().catch((e) => console.error(e.message));
