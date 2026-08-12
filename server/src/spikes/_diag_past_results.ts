/**
 * What did PAST live migrations actually record for SharePoint / Confluence / Jira / HubSpot?
 *
 * Spikes prove a mechanism; a migrationResults row proves the pipeline did it for a real
 * agent. This reads what is already in the DB rather than re-running anything.
 *
 * Read-only.  npx tsx src/spikes/_diag_past_results.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const rows = await getDb().collection('migrationResults').find({}).sort({ $natural: -1 }).limit(400).toArray();
console.log(`${rows.length} migrationResults row(s)\n`);

const RE = /sharepoint|confluence|jira|hubspot/i;
const seen = new Map<string, { status: string; detail: string; agent: string }[]>();
for (const r of rows as any[]) {
  for (const f of r.fidelity ?? []) {
    const text = `${f.component} ${f.detail}`;
    const m = RE.exec(text);
    if (!m) continue;
    const key = m[0].toLowerCase();
    const list = seen.get(key) ?? [];
    list.push({ status: f.status, detail: String(f.detail).slice(0, 200), agent: r.agentName ?? r.name ?? '?' });
    seen.set(key, list);
  }
}
for (const [k, list] of seen) {
  const byStatus = new Map<string, number>();
  for (const e of list) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  console.log(`\n${'='.repeat(76)}\n  ${k.toUpperCase()} — ${list.length} note(s): ${[...byStatus].map(([s, n]) => `${s}=${n}`).join('  ')}\n${'='.repeat(76)}`);
  const shown = new Set<string>();
  for (const e of list) {
    const sig = `${e.status}:${e.detail.slice(0, 70)}`;
    if (shown.has(sig)) continue;
    shown.add(sig);
    console.log(`\n  [${e.status}] ${e.agent}`);
    console.log(`     ${e.detail}`);
  }
}
process.exit(0);
