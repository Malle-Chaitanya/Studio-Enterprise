/**
 * Structural audit: what does Dataverse ACTUALLY record about an agent's connectors and
 * knowledge sources, ignoring names and descriptions entirely?
 *
 * Names and descriptions are user-typed and unreliable — one Confluence source in this
 * tenant is literally spelled "confulence". Any detection built on them is a guess. This
 * dumps every field of every component for every agent in one environment and reports
 * only STRUCTURAL evidence: enum kinds, api names (`shared_*`), connection references,
 * and cross-table links.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_agent_structure_audit.ts [envUrl]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

const ENV = process.argv[2] ?? 'https://orga243378d.crm.dynamics.com';
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const base = ENV.replace(/\/$/, '');
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

const bots = await listBots(ENV, token);
console.log(`${bots.length} agent(s) in ${ENV}\n`);

// ── 1. Every component, every field ──────────────────────────────────────────
const typeCounts = new Map<number, number>();
const kindsSeen = new Map<string, number>();          // source.kind / kind: values
const apiNames = new Map<string, Set<string>>();      // shared_* → agents
const connRefs = new Map<string, Set<string>>();      // connectionreference names → agents
const fieldsWithSignal = new Set<string>();
const perAgent = new Map<string, { kinds: Set<string>; apis: Set<string> }>();

for (const bot of bots) {
  const r = await fetch(
    `${base}/api/data/v9.2/botcomponents?$filter=${encodeURIComponent(`_parentbotid_value eq ${bot.botid}`)}&$top=200`,
    { headers: h },
  );
  if (!r.ok) continue;
  const comps = ((await r.json()) as { value?: Array<Record<string, unknown>> }).value ?? [];
  const agentEntry = { kinds: new Set<string>(), apis: new Set<string>() };

  for (const c of comps) {
    const ct = Number(c.componenttype);
    typeCounts.set(ct, (typeCounts.get(ct) ?? 0) + 1);

    for (const [field, value] of Object.entries(c)) {
      if (typeof value !== 'string' || !value) continue;

      // `kind:` lines are Copilot Studio's own enums — structural, not prose.
      for (const m of value.matchAll(/\bkind:\s*([A-Za-z0-9_]+)/g)) {
        kindsSeen.set(m[1], (kindsSeen.get(m[1]) ?? 0) + 1);
        agentEntry.kinds.add(m[1]);
        if (/source|search|knowledge/i.test(m[1])) fieldsWithSignal.add(field);
      }
      // `shared_xxx` is the Power Automate connector api name — the identifier the
      // registry keys on.
      for (const m of value.matchAll(/\bshared_[a-z0-9_]+/gi)) {
        if (!apiNames.has(m[0])) apiNames.set(m[0], new Set());
        apiNames.get(m[0])!.add(bot.name);
        agentEntry.apis.add(m[0]);
        fieldsWithSignal.add(field);
      }
      // Connection references bind an agent/flow to a specific connection.
      for (const m of value.matchAll(/connectionreference[s]?["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]+)/gi)) {
        if (!connRefs.has(m[1])) connRefs.set(m[1], new Set());
        connRefs.get(m[1])!.add(bot.name);
        fieldsWithSignal.add(field);
      }
    }
  }
  if (agentEntry.kinds.size || agentEntry.apis.size) perAgent.set(bot.name, agentEntry);
}

console.log('── componenttype distribution ──');
console.log(`  ${[...typeCounts].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join('  ')}`);

console.log('\n── `kind:` enums found (structural, not prose) ──');
for (const [k, n] of [...kindsSeen].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

console.log('\n── connector api names (shared_*) found in components ──');
if (apiNames.size === 0) console.log('  (none — agents do not name their connectors structurally)');
for (const [api, agents] of apiNames) console.log(`  ${api}  ← ${[...agents].join(', ')}`);

console.log('\n── connection references found ──');
if (connRefs.size === 0) console.log('  (none)');
for (const [ref, agents] of connRefs) console.log(`  ${ref}  ← ${[...agents].join(', ')}`);

console.log('\n── fields that carried any structural signal ──');
console.log(`  ${[...fieldsWithSignal].join(', ') || '(none)'}`);

// ── 2. Related tables that might hold the agent→connector link ────────────────
console.log('\n── related Dataverse tables ──');
for (const table of ['connectionreferences', 'connectors', 'botcomponentcollections']) {
  const rr = await fetch(`${base}/api/data/v9.2/${table}?$top=5`, { headers: h });
  if (!rr.ok) { console.log(`  ${table}: ${rr.status}`); continue; }
  const rows = ((await rr.json()) as { value?: Array<Record<string, unknown>> }).value ?? [];
  console.log(`  ${table}: ${rows.length} row(s) sampled`);
  if (rows[0]) {
    const keys = Object.keys(rows[0]).filter((k) => !k.startsWith('@')).slice(0, 14);
    console.log(`    fields: ${keys.join(', ')}`);
    for (const row of rows.slice(0, 3)) {
      const label = row['connectionreferencedisplayname'] ?? row['name'] ?? row['connectorid'] ?? '?';
      const api = row['connectorid'] ?? row['customconnectorid'] ?? '';
      console.log(`      ${String(label)}  api=${String(api)}`);
    }
  }
}

console.log('\n── per-agent structural summary ──');
for (const [name, e] of perAgent) {
  console.log(`  ${name}`);
  console.log(`     kinds: ${[...e.kinds].join(', ') || '-'}`);
  console.log(`     apis : ${[...e.apis].join(', ') || '-'}`);
}
process.exit(0);
