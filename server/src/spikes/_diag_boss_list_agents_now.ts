import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'global';
const ENGINE = 'gemini-enterprise-app_1787446545912';

async function main() {
  const token = await getSaToken();
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log('HTTP status:', res.status);
  const json = await res.json();
  const agents = json.agents ?? [];
  console.log(`Found ${agents.length} agent(s):\n`);
  for (const a of agents) {
    console.log(`- ${a.displayName} (${a.name?.split('/').pop()}) state=${a.state}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
