/**
 * Where does the REAL HTTP call behind a Copilot connector operation live?
 *
 * We extract `connectorId` + `operationId` (e.g. shared_jira + ListIssues) and then throw
 * the operation away. The deployed agent gets either a hand-written Python tool or a
 * generic `call_external_api(path, method, body)` that asks the model to invent the path.
 * Neither reproduces what Copilot actually did.
 *
 * To rebuild an operation faithfully we need its verb, path, parameters and response
 * shape. This probe asks WHERE that is obtainable from, in cheapest-first order:
 *
 *   1. The TaskDialog payload itself — already in hand, no new permission. If the inputs
 *      are described here, every connector becomes mechanical with zero external calls.
 *   2. The Dataverse `connector` table — holds `openapidefinition` for connectors in the
 *      environment. Reachable with the app-only token we already mint.
 *   3. Power Platform / Power Apps connector APIs — the authoritative swagger, but a
 *      DIFFERENT token audience, so it may need consent our app has never been granted.
 *
 * The answer decides the architecture: a generic swagger-driven tool emitter is only real
 * if one of these returns operation-level detail. If none do, every connector stays
 * hand-written and "any connector" is not a promise we can make.
 *
 * Read-only. GETs and token mints only — creates nothing.
 *
 * npx tsx src/spikes/_probe_connector_operation_schema.ts [envUrl]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
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
const tenant = s.tenantId;
const dvToken = await clientCredsToken(tenant, ENV);
const base = ENV.replace(/\/$/, '');

async function dv(path: string): Promise<any> {
  const res = await fetch(`${base}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${dvToken}`, Accept: 'application/json' },
  });
  if (!res.ok) return { __error: `${res.status} ${(await res.text()).slice(0, 300)}` };
  return res.json();
}

console.log(`\n═══ tenant ${tenant} · env ${ENV} ═══\n`);

// ── 1. The TaskDialog payload — what is ALREADY in hand ──────────────────────
// Printed in full for a couple of real connector tools. The question is not "does it
// name the operation" (we know it does) but whether it describes the operation's INPUTS
// well enough to build a typed tool without any external schema at all.
console.log('─── 1. raw TaskDialog payloads (what we already have) ───');
const bots = await listBots(ENV, dvToken);
let shown = 0;
const operationIds = new Set<string>();
const connectorIds = new Set<string>();

for (const b of bots) {
  if (shown >= 3) break;
  const comps = await dv(
    `botcomponents?$select=name,data,schemaname&$filter=_parentbotid_value eq ${b.botid} and componenttype eq 9&$top=50`,
  );
  if (comps.__error) continue;
  for (const c of comps.value ?? []) {
    const data: string = c.data ?? '';
    if (!/^\s*kind:\s*TaskDialog\s*$/m.test(data)) continue;
    const op = /^\s*operationId:\s*(\S+)\s*$/m.exec(data)?.[1];
    const conn = /\b(shared_[a-z0-9_]+)/i.exec(data)?.[1];
    if (op) operationIds.add(op);
    if (conn) connectorIds.add(conn.toLowerCase());
    if (shown >= 3) continue;
    console.log(`\n  ▸ ${b.name} → ${c.name}   [${conn ?? '?'} / ${op ?? '?'}]`);
    console.log('  ' + '─'.repeat(70));
    // FULL payload, not a filtered view: the whole point is to find fields we do not
    // already know to look for. A grep here could only return what we already suspected.
    console.log(
      data
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')
        .slice(0, 4000),
    );
    if (data.length > 4000) console.log(`    … (${data.length - 4000} more chars)`);
    shown++;
  }
}
console.log(`\n  connectors seen: ${[...connectorIds].join(', ') || '(none)'}`);
console.log(`  operations seen: ${[...operationIds].join(', ') || '(none)'}`);

// ── 2. Dataverse `connector` table ───────────────────────────────────────────
// Custom connectors definitely live here. Whether FIRST-PARTY (shared_jira etc.) rows
// appear, and whether openapidefinition is populated for them, is the open question.
console.log('\n─── 2. Dataverse `connector` table (openapidefinition) ───');
const conns = await dv('connectors?$select=name,connectorinternalid,statecode&$top=50');
if (conns.__error) {
  console.log(`  ERROR: ${conns.__error}`);
} else {
  const rows: any[] = conns.value ?? [];
  console.log(`  ${rows.length} row(s)`);
  for (const r of rows.slice(0, 20)) {
    console.log(`   • ${r.name} — internalId=${r.connectorinternalid ?? '—'} state=${r.statecode}`);
  }
  // Fetch the definition for ONE row only: these blobs are large and one is enough to
  // learn whether operationIds are keys into it.
  if (rows[0]) {
    const one = await dv(`connectors(${rows[0].connectorid})?$select=name,openapidefinition`);
    if (one.__error) {
      console.log(`  openapidefinition fetch: ERROR ${one.__error}`);
    } else {
      const def = one.openapidefinition;
      console.log(`  openapidefinition present: ${def ? `yes (${String(def).length} chars)` : 'NO'}`);
      if (def) {
        try {
          const parsed = JSON.parse(def);
          const paths = Object.keys(parsed.paths ?? {});
          console.log(`    paths: ${paths.length}`);
          // The decisive check: does an operationId we extracted appear as a key?
          const ops: string[] = [];
          for (const [p, verbs] of Object.entries<any>(parsed.paths ?? {})) {
            for (const [verb, o] of Object.entries<any>(verbs ?? {})) {
              if (o?.operationId) ops.push(`${o.operationId} = ${verb.toUpperCase()} ${p}`);
            }
          }
          console.log(`    operationIds: ${ops.length}`);
          for (const o of ops.slice(0, 10)) console.log(`      ${o}`);
        } catch {
          console.log('    (openapidefinition is not JSON — printing head)');
          console.log(`    ${String(def).slice(0, 300)}`);
        }
      }
    }
  }
}

// ── 3. External connector-definition APIs (different token audience) ─────────
// Each needs its own audience. A 401/403 here means our app registration has never been
// granted that API — a consent problem, not a "the data does not exist" problem, and the
// two must not be confused when reading this output.
console.log('\n─── 3. Power Platform / Power Apps connector APIs ───');
const TARGETS: Array<{ label: string; resource: string; url: (t: string) => string }> = [
  {
    label: 'Power Apps  apis/shared_jira?$expand=swagger',
    resource: 'https://service.powerapps.com',
    url: () =>
      'https://api.powerapps.com/providers/Microsoft.PowerApps/apis/shared_jira?api-version=2016-11-01&$expand=swagger',
  },
  {
    label: 'Power Platform  connectivity/connectors',
    resource: 'https://api.powerplatform.com',
    url: () => 'https://api.powerplatform.com/connectivity/connectors?api-version=2022-03-01-preview',
  },
  {
    label: 'Power Apps  apis (list all)',
    resource: 'https://service.powerapps.com',
    url: () => 'https://api.powerapps.com/providers/Microsoft.PowerApps/apis?api-version=2016-11-01',
  },
];

for (const t of TARGETS) {
  let token: string;
  try {
    token = await clientCredsToken(tenant, t.resource);
  } catch (err) {
    console.log(`  TOKEN FAILED  ${t.label}`);
    console.log(`     audience ${t.resource} — ${(err as Error).message.slice(0, 200)}`);
    continue;
  }
  try {
    const res = await fetch(t.url(token), { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    console.log(`  ${res.ok ? 'ok  ' : `${res.status} `} ${t.label}`);
    if (!res.ok) {
      console.log(`     ${text.slice(0, 250)}`);
      continue;
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      console.log(`     (non-JSON) ${text.slice(0, 200)}`);
      continue;
    }
    const list = json.value ?? [json];
    console.log(`     ${list.length} item(s)`);
    for (const item of list.slice(0, 5)) {
      const p = item.properties ?? {};
      const sw = p.swagger;
      const opCount = sw?.paths ? Object.keys(sw.paths).length : 0;
      console.log(`     • ${item.name ?? p.displayName ?? '?'} swaggerPaths=${opCount || '—'}`);
    }
  } catch (err) {
    console.log(`  network ${t.label} — ${(err as Error).message.slice(0, 200)}`);
  }
}

// ── 4. Power Apps connector API, WITH the environment filter ─────────────────
// §3 came back 400 MissingEnvironmentFilter, not 401/403 — the token was ACCEPTED and the
// query was malformed. That makes this the decisive test: with a real environment id, does
// the API return a swagger whose operationIds match the ones §1 extracted?
console.log('\n─── 4. Power Apps connector API + environment filter ───');
const envs = await discoverEnvironments(tenant);
const env = envs.find((e) => e.url.replace(/\/$/, '') === base) ?? envs[0];
console.log(`  ${envs.length} environment(s); using ${env?.name ?? '?'} (${env?.id ?? '—'})`);

if (!env?.id) {
  console.log('  no environment id — cannot filter');
} else {
  const paToken = await clientCredsToken(tenant, 'https://service.powerapps.com');
  const probeConnectors = [...connectorIds].length ? [...connectorIds] : ['shared_confluence'];
  for (const cid of probeConnectors.slice(0, 3)) {
    const url =
      `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${cid}` +
      `?api-version=2016-11-01&$filter=environment eq '${env.id}'&$expand=swagger`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${paToken}` } });
      const text = await res.text();
      if (!res.ok) {
        console.log(`  ${res.status}  ${cid}`);
        console.log(`     ${text.slice(0, 250)}`);
        continue;
      }
      const json = JSON.parse(text);
      const sw = json.properties?.swagger;
      const paths = Object.keys(sw?.paths ?? {});
      console.log(`  ok   ${cid} — ${json.properties?.displayName ?? ''} · ${paths.length} path(s)`);
      // The whole probe reduces to this: are the operationIds we extract from Dataverse
      // keys into this document? If yes, every connector operation is mechanically
      // reproducible and the tool emitter can be generic.
      const ops: Record<string, string> = {};
      for (const [p, verbs] of Object.entries<any>(sw?.paths ?? {})) {
        for (const [verb, o] of Object.entries<any>(verbs ?? {})) {
          if (o?.operationId) ops[o.operationId] = `${verb.toUpperCase()} ${p}`;
        }
      }
      console.log(`       ${Object.keys(ops).length} operationId(s)`);
      for (const want of operationIds) {
        if (ops[want]) {
          console.log(`       MATCH  ${want} = ${ops[want]}`);
          // Print the parameter list for one match — this is what a typed tool needs.
          for (const [p, verbs] of Object.entries<any>(sw?.paths ?? {})) {
            for (const o of Object.values<any>(verbs ?? {})) {
              if (o?.operationId !== want) continue;
              const params = (o.parameters ?? []).map(
                (x: any) => `${x.name}:${x.type ?? x.schema?.type ?? '?'}${x.required ? '*' : ''} (${x.in})`,
              );
              console.log(`              params: ${params.join(', ') || '(none)'}`);
              console.log(`              summary: ${(o.summary ?? '').slice(0, 100)}`);
            }
          }
        }
      }
    } catch (err) {
      console.log(`  network ${cid} — ${(err as Error).message.slice(0, 200)}`);
    }
  }
}

console.log('\n═══ How to read this ═══');
console.log('  §1 shows input params  → connectors are mechanical with NO external call. Best case.');
console.log('  §1 names the op only   → we need §2 or §3 to rebuild the call faithfully.');
console.log('  §2 has matching ops    → Dataverse is the source; same token, no new consent.');
console.log('  §3 200 with swagger    → authoritative source, but needs its own API consent.');
console.log('  §3 401/403             → NOT proof the data is absent — our app lacks that API grant.\n');
process.exit(0);
