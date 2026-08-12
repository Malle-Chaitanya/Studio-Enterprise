/**
 * Two questions this answers, both about "can we actually migrate Hubspot agentt":
 *
 *   1. Did the InlineAgentSkill parse into a usable sub-agent (name/description/body)?
 *   2. Does Dataverse hold the OpenAPI definition for a CUSTOM connector?
 *
 * (2) is the one that matters. A custom connector has no fixture in our registry, so its
 * operations are reported `lost` — honest, but the capability is gone. Power Platform
 * stores custom connector definitions in the `connector` table with an
 * `openapidefinition` column. If that is readable, a custom connector can be bound the
 * same way a first-party one is, and "no connector support" stops being the answer.
 *
 * Read-only. Prints shapes and operation names, never credential values or payload bodies.
 *
 * npx tsx src/spikes/_probe_custom_connector.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch {
    continue;
  }
  const bot = bots.find((b) => b.name.toLowerCase().includes('hubspot agentt'));
  if (!bot) continue;

  // ── 1. the inline skill ────────────────────────────────────────────────────────────
  const ir = await extractAgent(env.url, token, bot);
  console.log('\n══ topics after the fix (the InlineAgentSkill should be one of them)\n');
  for (const t of ir.topics ?? []) {
    console.log(`  name:        ${t.name}`);
    console.log(`  description: ${(t.modelDescription ?? '(none)').slice(0, 140)}`);
    console.log(`  summary:     ${t.summary.length} chars`);
    console.log(`  first lines: ${t.summary.split('\n').slice(0, 3).join(' / ').slice(0, 150)}`);
  }

  // ── 2. the custom connector definition ─────────────────────────────────────────────
  console.log('\n══ custom connectors in the `connector` table\n');
  const res = await fetch(
    `${env.url}/api/data/v9.2/connectors?$select=name,connectorinternalid,displayname,statecode&$top=50`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!res.ok) {
    console.log(`  connectors table: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
  } else {
    const rows = ((await res.json()) as {
      value?: Array<{ name?: string; connectorinternalid?: string; displayname?: string; connectorid?: string }>;
    }).value ?? [];
    console.log(`  ${rows.length} row(s)`);
    for (const r of rows) {
      console.log(`    ${(r.displayname ?? r.name ?? '(unnamed)').slice(0, 40).padEnd(40)} internalid=${r.connectorinternalid ?? '(none)'}`);
    }

    const hub = rows.find((r) => /hubspot/i.test(`${r.displayname} ${r.name} ${r.connectorinternalid}`));
    if (hub) {
      console.log(`\n══ OpenAPI definition for "${hub.displayname ?? hub.name}"\n`);
      const one = await fetch(
        `${env.url}/api/data/v9.2/connectors?$select=name,displayname,openapidefinition,connectorinternalid` +
          `&$filter=connectorinternalid eq '${hub.connectorinternalid}'`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      );
      if (!one.ok) {
        console.log(`  HTTP ${one.status} — ${(await one.text()).slice(0, 200)}`);
      } else {
        const row = ((await one.json()) as { value?: Array<{ openapidefinition?: string }> }).value?.[0];
        const def = row?.openapidefinition;
        if (!def) {
          console.log('  openapidefinition is EMPTY — cannot bind from here.');
        } else {
          console.log(`  openapidefinition: ${def.length} chars`);
          try {
            const doc = JSON.parse(def) as {
              host?: string;
              basePath?: string;
              schemes?: string[];
              securityDefinitions?: Record<string, { type?: string }>;
              paths?: Record<string, Record<string, { operationId?: string }>>;
            };
            console.log(`  host:     ${doc.host ?? '(none)'}`);
            console.log(`  basePath: ${doc.basePath ?? '(none)'}   schemes: ${(doc.schemes ?? []).join(',')}`);
            console.log(`  security: ${Object.entries(doc.securityDefinitions ?? {}).map(([k, v]) => `${k}=${v.type}`).join(', ') || '(none)'}`);
            const ops: string[] = [];
            for (const [p, methods] of Object.entries(doc.paths ?? {})) {
              for (const [m, op] of Object.entries(methods)) {
                ops.push(`${op.operationId ?? '(no id)'} — ${m.toUpperCase()} ${p}`);
              }
            }
            console.log(`  operations: ${ops.length}`);
            for (const o of ops.slice(0, 20)) console.log(`    ${o}`);
          } catch (e) {
            console.log(`  not JSON: ${(e as Error).message.slice(0, 80)}`);
            console.log(`  first 200 chars: ${def.slice(0, 200)}`);
          }
        }
      }
    } else {
      console.log('\n  no row matching "hubspot" — the custom connector is not in this table.');
    }
  }

  // The Dataverse `connector` table only holds SOLUTION-aware custom connectors. One
  // created outside a solution lives in the Power Apps API instead, which is where the
  // ConnectorTool row's ARM path points. This is the last place its swagger could be.
  console.log('\n══ Power Apps API — the ARM path the ConnectorTool row names\n');
  const apiName = 'shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b';
  const paToken = await clientCredsToken(tenantId, 'https://service.powerapps.com').catch(() => '');
  if (!paToken) {
    console.log('  could not acquire a Power Apps token');
  } else {
    const url =
      `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${apiName}` +
      `?api-version=2016-11-01&$filter=environment eq '${env.id}'`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${paToken}`, Accept: 'application/json' } });
    console.log(`  GET .../apis/${apiName.slice(0, 40)}…  →  HTTP ${r.status}`);
    const body = await r.text();
    if (r.ok) {
      const doc = JSON.parse(body) as { properties?: { displayName?: string; swagger?: { host?: string; paths?: Record<string, unknown> } } };
      const sw = doc.properties?.swagger;
      console.log(`  displayName: ${doc.properties?.displayName ?? '(none)'}`);
      console.log(`  swagger host: ${sw?.host ?? '(none)'}`);
      console.log(`  swagger paths: ${Object.keys(sw?.paths ?? {}).length}`);
    } else {
      console.log(`  ${body.slice(0, 300)}`);
    }
  }
}
process.exit(0);
