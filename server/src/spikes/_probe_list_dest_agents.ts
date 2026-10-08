/** Every agent currently in the destination engine, newest first. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = process.env.GEMINI_PROJECT || 'agentmigrations';
const ENGINE = process.env.ENGINE || 'gemini-enterprise-app_1787446545912';
const token = await getSaToken(process.env.SUBJECT || 'admin@migrationn.com');
const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const j = (await r.json()) as any;
if (j.error) { console.log('ERR ' + JSON.stringify(j.error).slice(0, 300)); process.exit(0); }
for (const a of j.agents ?? []) {
  console.log(`${String(a.displayName).padEnd(28)} ${String(a.name).split('/').pop()}  state=${a.state ?? '-'}`);
}
console.log(`(${(j.agents ?? []).length} agents)`);
process.exit(0);
