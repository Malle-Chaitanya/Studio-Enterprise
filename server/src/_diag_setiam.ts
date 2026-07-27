/** Test Gemini's claim: does :setIamPolicy flip an agent PRIVATE -> ENABLED?
 *  No mongo. Token via SA key + GOOGLE_IMPERSONATE_EMAIL.
 *   npx tsx src/_diag_setiam.ts <project> <engineId> <agentId> */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;

async function state(token: string): Promise<string> {
  const r = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await r.json()) as { state?: string };
  return j.state ?? `(read ${r.status})`;
}

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) throw new Error('usage: _diag_setiam.ts <project> <engineId> <agentId>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  console.log(`state BEFORE = ${await state(token)}`);

  // Try both the setIamPolicy that Gemini suggested, and a getIamPolicy to see if it even exists.
  const getIam = await fetch(`${BASE}:getIamPolicy`, { method: 'POST', headers: h, body: '{}' });
  console.log(`\n:getIamPolicy -> ${getIam.status}  ${(await getIam.text()).replace(/\s+/g, ' ').slice(0, 200)}`);

  const body = JSON.stringify({ policy: { bindings: [{ role: 'roles/discoveryengine.agentUser', members: ['user:' + (process.env.GOOGLE_IMPERSONATE_EMAIL || 'zara@storefuze.com')] }] } });
  const setIam = await fetch(`${BASE}:setIamPolicy`, { method: 'POST', headers: h, body });
  console.log(`\n:setIamPolicy -> ${setIam.status}  ${(await setIam.text()).replace(/\s+/g, ' ').slice(0, 300)}`);

  console.log(`\nstate AFTER = ${await state(token)}`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
