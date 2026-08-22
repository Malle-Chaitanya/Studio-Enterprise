/**
 * READ-ONLY. For the 5 agents chosen for the end-to-end run, what exists in the destination?
 *
 * Two independent sources, printed side by side on purpose:
 *   1. our own adkDeployments records (what the pipeline would REUSE, keyed by sourceId)
 *   2. the engine's live agent list (what a human SEES in the console, keyed by display name)
 * They disagree — duplicates exist under one name, and a record can point at an id that was
 * deleted out of band. Deleting off the name alone would take the wrong copy, so print both
 * and let a human match them before anything is removed.
 *
 *   cd server && npx tsx src/spikes/_diag_dest_copies_of_five.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

const FIVE: Array<[string, string]> = [
  ['Enterprise Migration Knowledge', 'bdf9b817'],
  ['Teams Coordinator', '9b97b5fc'],
  ['Email Manager', '45d6b647'],
  ['HubSpot Agent', '442c7099'],
  ['Confluence Knowledge Assistant', '87aaf041'],
];
const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

await connectMongo();
const deploys = (await getDb().collection('adkDeployments').find({}).toArray()) as Array<Record<string, unknown>>;
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
const r = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
const live = ((await r.json()) as { agents?: Array<{ name: string; displayName?: string; state?: string }> }).agents ?? [];
console.log(`engine has ${live.length} agent(s) (GET ${r.status})\n`);

for (const [name, pre] of FIVE) {
  console.log(`--- ${name} (sourceId ${pre}...) ---`);
  const recs = deploys.filter((d) => JSON.stringify(d).includes(pre));
  if (!recs.length) console.log('  record:  none — a fresh create, nothing to delete');
  for (const d of recs) {
    const agentId = String(d.agentId ?? '?');
    // Ask the API, because a record surviving a console delete is a known live failure mode.
    const ok = await fetch(`${BASE}/${agentId}`, { headers: { Authorization: `Bearer ${token}` } });
    const hit = live.find((a) => a.name.endsWith(`/${agentId}`));
    console.log(
      `  record:  agentId=${agentId} appUserId=${String(d.appUserId)} reasoningEngine=${String(d.reasoningEngineId ?? d.engineId ?? '-')}`,
    );
    console.log(`           GET -> ${ok.status}${hit ? `  displayName="${hit.displayName}" state=${hit.state}` : '  (not in the engine list)'}`);
  }
  const byName = live.filter((a) => (a.displayName ?? '').trim() === name);
  console.log(`  by name: ${byName.length} agent(s) in the console with this EXACT display name`);
  for (const a of byName) console.log(`           ${a.name.split('/').pop()}  state=${a.state}`);
  const near = live.filter((a) => {
    const dn = (a.displayName ?? '').trim();
    return dn !== name && dn.toLowerCase().includes(name.toLowerCase().split(' ')[0]);
  });
  for (const a of near) console.log(`  similar: "${a.displayName}"  ${a.name.split('/').pop()}  state=${a.state}  <-- NOT an exact match, do not delete on a hunch`);
  console.log('');
}
process.exit(0);
