/** Test whether PATCHing sharingConfig.scope changes state or gallery visibility.
 *  No mongo. npx tsx src/_diag_patch_sharing.ts <project> <engineId> <agentId> */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;

async function getAgent(token: string): Promise<{ state?: string; sharingConfig?: unknown }> {
  const r = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
  return r.json() as Promise<{ state?: string; sharingConfig?: unknown }>;
}

async function tryPatch(h: Record<string, string>, scope: string): Promise<void> {
  const body = JSON.stringify({ sharingConfig: { scope } });
  const r = await fetch(`${BASE}?updateMask=sharingConfig`, { method: 'PATCH', headers: h, body });
  const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
  console.log(`  PATCH scope=${scope} -> ${r.status}  ${t}`);
}

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) throw new Error('usage: _diag_patch_sharing.ts <project> <engineId> <agentId>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const before = await getAgent(token);
  console.log(`--- BEFORE ---  state=${before.state}  sharingConfig=${JSON.stringify(before.sharingConfig ?? {})}`);

  console.log(`\n--- PATCH attempts (which scope enum is even valid?) ---`);
  await tryPatch(h, 'ORGANIZATION');
  await tryPatch(h, 'SHARED');
  await tryPatch(h, 'PUBLIC');
  await tryPatch(h, 'ALL_USERS'); // known-valid control

  const after = await getAgent(token);
  console.log(`\n--- AFTER ---  state=${after.state}  sharingConfig=${JSON.stringify(after.sharingConfig ?? {})}`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
