/** Test the official agents.patch (edit) API: can we update displayName /
 *  description on an existing agent? (No create-quota consumed — it's an update.)
 *   npx tsx src/_diag_patch_agent.ts <project> <engineId> <agentId> <newDisplayName> <newDescription> */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, AGENT, NAME, DESC] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;

async function read(token: string): Promise<{ displayName?: string; description?: string; state?: string }> {
  const r = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
  return r.json() as Promise<{ displayName?: string; description?: string; state?: string }>;
}

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) throw new Error('usage: _diag_patch_agent.ts <project> <engineId> <agentId> [newName] [newDesc]');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const before = await read(token);
  console.log(`BEFORE: displayName="${before.displayName}" description="${before.description}" state=${before.state}`);

  const body: Record<string, string> = {};
  const masks: string[] = [];
  if (NAME) { body.displayName = NAME; masks.push('displayName'); }
  if (DESC) { body.description = DESC; masks.push('description'); }
  if (!masks.length) { console.log('(no fields to patch — pass newName/newDesc)'); process.exit(0); }

  const r = await fetch(`${BASE}?updateMask=${masks.join(',')}`, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
  const text = await r.text();
  console.log(`\nPATCH updateMask=${masks.join(',')} -> ${r.status}`);
  if (!r.ok) console.log(text.replace(/\s+/g, ' ').slice(0, 400));

  const after = await read(token);
  console.log(`\nAFTER:  displayName="${after.displayName}" description="${after.description}"`);
  console.log(after.displayName === (NAME || before.displayName) && after.description === (DESC || before.description)
    ? '\n✅ EDIT API WORKS — fields updated in place (reflects in the console/gallery).'
    : '\n⚠️ fields did not fully update (see status above).');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
