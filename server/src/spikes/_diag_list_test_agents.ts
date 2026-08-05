import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const ENGINE = 'agentspace-engine';
const ASSISTANT = 'default_assistant';

async function main() {
  const token = await getSaToken('zara@storefuze.com');
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/${ASSISTANT}/agents?pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log('status:', res.status);
  const json = (await res.json()) as { agents?: { name?: string; displayName?: string }[] };
  const agents = (json.agents ?? []).map((a) => ({ name: a.name, displayName: a.displayName }));
  console.log(JSON.stringify(agents, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
