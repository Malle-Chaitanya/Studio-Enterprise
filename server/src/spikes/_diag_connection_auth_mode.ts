/**
 * Does Dataverse record whether a connector authenticated as the SIGNED-IN USER or as a
 * single shared maker connection?
 *
 * Why it matters: an agent whose connectors used per-user auth migrates onto one app-only
 * service credential, so every end user of the migrated agent inherits everything that
 * identity can see. That is privilege escalation, not a fidelity gap. Today
 * dataverse.ts:583 reads `connectionReference` only to derive the connector id and throws
 * the auth mode away, so we cannot even count how many agents are affected.
 *
 * This dumps every field of `connectionreferences` plus the raw action payloads, and
 * flags any key that looks like an auth-mode discriminator. It asserts nothing about
 * field names — the point is to find out what they are.
 *
 * Read-only. Creates nothing, deploys nothing.
 *
 * npx tsx src/spikes/_diag_connection_auth_mode.ts [envUrl]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

const ENV = process.argv[2] ?? 'https://orga243378d.crm.dynamics.com';
await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId) {
  console.error('No session with a tenantId in Mongo — sign in through the UI once first.');
  process.exit(1);
}
const token = await clientCredsToken(s.tenantId, ENV);
const base = ENV.replace(/\/$/, '');
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

async function get(path: string): Promise<any> {
  const res = await fetch(`${base}/api/data/v9.2/${path}`, { headers: h });
  if (!res.ok) return { __error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return res.json();
}

/** Keys whose NAME suggests they discriminate shared vs per-user auth. */
const SUSPECT = /auth|invoker|onbehalf|delegat|impersonat|principal|user|consent|connectiontype|mode|shared/i;

console.log(`\n═══ Environment: ${ENV} ═══\n`);

// ── 1. connectionreferences — every column, not a $select ────────────────────
// No $select on purpose: the whole question is which column carries the answer, and a
// $select can only return fields we already suspected.
console.log('─── 1. connectionreferences (all columns) ───');
const refs = await get('connectionreferences?$top=50');
if (refs.__error) {
  console.log(`  ERROR: ${refs.__error}`);
} else {
  const rows: any[] = refs.value ?? [];
  console.log(`  ${rows.length} row(s)`);
  const allKeys = new Set<string>();
  for (const r of rows) Object.keys(r).forEach((k) => allKeys.add(k));
  const suspects = [...allKeys].filter((k) => SUSPECT.test(k) && !k.startsWith('@'));
  console.log(`  columns present: ${allKeys.size}`);
  console.log(`  AUTH-LOOKING columns: ${suspects.length ? suspects.join(', ') : '(none)'}\n`);
  for (const r of rows.slice(0, 12)) {
    console.log(`  • ${r.connectionreferencedisplayname ?? r.connectionreferencelogicalname ?? '(unnamed)'}`);
    console.log(`      connectorid : ${r.connectorid ?? '—'}`);
    // connectionid empty is itself a signal: a shared maker connection is bound at
    // design time and has one; a per-user connection is bound at run time and does not.
    console.log(`      connectionid: ${r.connectionid ?? '(EMPTY — may indicate per-user binding)'}`);
    for (const k of suspects) {
      if (r[k] !== undefined && r[k] !== null) console.log(`      ${k}: ${JSON.stringify(r[k])}`);
    }
  }
}

// ── 2. The bot's own authentication configuration ────────────────────────────
// Copilot's agent-level auth mode ("no authentication" / "Microsoft" / "manual") governs
// whether an end-user identity exists at all for a connector to borrow.
console.log('\n─── 2. bot authentication settings ───');
const bots = await listBots(ENV, token);
console.log(`  ${bots.length} agent(s)\n`);
for (const b of bots.slice(0, 20)) {
  const one = await get(`bots(${b.botid})`);
  if (one.__error) {
    console.log(`  • ${b.name}: ERROR ${one.__error}`);
    continue;
  }
  const authKeys = Object.keys(one).filter((k) => SUSPECT.test(k) && !k.startsWith('@'));
  const shown = authKeys
    .filter((k) => one[k] !== null && one[k] !== undefined && one[k] !== '')
    .map((k) => `${k}=${JSON.stringify(one[k]).slice(0, 80)}`);
  console.log(`  • ${b.name}`);
  console.log(`      ${shown.length ? shown.join('\n      ') : '(no non-empty auth-looking fields)'}`);
}

// ── 3. Raw action payloads — where the per-action setting would live ─────────
// componenttype 9 carries both Topics and TaskDialog tools. A connector action that can
// run as the signed-in user would say so here, in the YAML/JSON the author never sees.
console.log('\n─── 3. connector action payloads (componenttype 9) ───');
for (const b of bots.slice(0, 20)) {
  const comps = await get(
    `botcomponents?$filter=_parentbotid_value eq ${b.botid} and componenttype eq 9&$select=name,data&$top=50`,
  );
  if (comps.__error) continue;
  for (const c of comps.value ?? []) {
    const data: string = c.data ?? '';
    if (!/kind:\s*TaskDialog/.test(data) && !/connectionReference/i.test(data)) continue;
    // Report only the lines that mention connections or auth — the payloads are long and
    // the surrounding topic YAML is noise for this question.
    const hits = data
      .split('\n')
      .filter((line) => /connection|auth|invoker|onbehalf|consent|identity/i.test(line))
      .map((line) => line.trim())
      .slice(0, 12);
    if (!hits.length) continue;
    console.log(`\n  • ${b.name} → ${c.name}`);
    for (const line of hits) console.log(`      ${line.slice(0, 160)}`);
  }
}

console.log('\n═══ What to look for ═══');
console.log('  A per-user connection should show up as ONE of:');
console.log('    - an empty connectionid on the connectionreference (bound at run time, not design time)');
console.log('    - an explicit mode field on the reference or the action payload');
console.log('    - the bot requiring user authentication at all (section 2)');
console.log('  If none of these separate the two, the mode is not in Dataverse and the');
console.log('  detection has to come from the Power Platform connections API instead.\n');
process.exit(0);
