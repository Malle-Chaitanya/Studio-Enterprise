/**
 * Can we read custom connector definitions WITHOUT the owner sharing each one with us?
 *
 * The per-connector share works but does not scale: a customer with twenty custom
 * connectors would have to share twenty resources before their agents migrate. Power
 * Platform exposes admin-scoped variants of most APIs, and we already hold an admin BAP
 * token for environment discovery. If an admin scope returns the swagger, the answer to
 * "will this work for any agent" changes from "after N grants" to "yes".
 *
 * Tries the candidate endpoints and prints exactly what each returns. Read-only.
 *
 * npx tsx src/spikes/_probe_admin_apis.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';

const API = 'shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;
const env = (await discoverEnvironments(tenantId)).find((e) => /org32322095/.test(e.url))!;
console.log(`environment: ${env.name}  id=${env.id}\n`);

const bap = await clientCredsToken(tenantId, 'https://api.bap.microsoft.com');
const pa = await clientCredsToken(tenantId, 'https://service.powerapps.com').catch(() => '');

const CANDIDATES: Array<{ label: string; url: string; token: string }> = [
  {
    label: 'BAP admin — connectors in environment',
    token: bap,
    url:
      `https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin` +
      `/environments/${env.id}/connectors?api-version=2020-10-01`,
  },
  {
    label: 'PowerApps admin scope — apis in environment',
    token: pa,
    url:
      `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin` +
      `/environments/${env.id}/apis?api-version=2016-11-01`,
  },
  {
    label: 'PowerApps admin scope — this one api (with swagger)',
    token: pa,
    url:
      `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin` +
      `/environments/${env.id}/apis/${API}?api-version=2016-11-01&$expand=properties/swagger`,
  },
  {
    label: 'PowerApps admin scope — apis WITH $expand=properties/swagger',
    token: pa,
    url:
      `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin` +
      `/environments/${env.id}/apis?api-version=2016-11-01&$expand=properties/swagger`,
  },
  {
    label: 'PowerApps admin scope — single api, no expand',
    token: pa,
    url:
      `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin` +
      `/environments/${env.id}/apis/${API}?api-version=2016-11-01`,
  },
  {
    label: 'PowerApps user scope — single api WITH swagger expand',
    token: pa,
    url:
      `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${API}` +
      `?api-version=2016-11-01&$expand=properties/swagger&$filter=environment eq '${env.id}'`,
  },
  {
    label: 'PowerApps user scope — apis in environment (baseline)',
    token: pa,
    url: `https://api.powerapps.com/providers/Microsoft.PowerApps/apis?api-version=2016-11-01&$filter=environment eq '${env.id}'`,
  },
];

for (const c of CANDIDATES) {
  if (!c.token) {
    console.log(`── ${c.label}\n   no token\n`);
    continue;
  }
  const r = await fetch(c.url, { headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' } });
  const body = await r.text();
  console.log(`── ${c.label}`);
  console.log(`   HTTP ${r.status}`);
  if (r.ok) {
    try {
      const doc = JSON.parse(body) as {
        value?: Array<{ name?: string; properties?: { displayName?: string; swagger?: unknown } }>;
        properties?: { displayName?: string; swagger?: { host?: string; paths?: Record<string, unknown> } };
      };
      if (doc.value) {
        console.log(`   ${doc.value.length} api(s)`);
        for (const a of doc.value.slice(0, 12)) {
          console.log(`     ${(a.properties?.displayName ?? a.name ?? '?').slice(0, 44).padEnd(44)} swagger=${a.properties?.swagger ? 'PRESENT' : 'absent'}`);
        }
      } else {
        const sw = doc.properties?.swagger;
        console.log(`   displayName: ${doc.properties?.displayName ?? '(none)'}`);
        console.log(`   swagger host: ${sw?.host ?? '(none)'}  paths: ${Object.keys(sw?.paths ?? {}).length}`);
      }
    } catch {
      console.log(`   (unparsed) ${body.slice(0, 200)}`);
    }
  } else {
    console.log(`   ${body.slice(0, 260)}`);
  }
  console.log('');
}

// What does the admin 200 actually carry? PowerApps often exposes the definition
// indirectly via properties.apiDefinitions.originalSwaggerUrl rather than inline.
console.log('\n── raw properties on the admin list row\n');
const r = await fetch(
  `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin` +
    `/environments/${env.id}/apis?api-version=2016-11-01`,
  { headers: { Authorization: `Bearer ${pa}`, Accept: 'application/json' } },
);
const row = ((await r.json()) as { value?: Array<{ properties?: Record<string, unknown> }> }).value?.[0];
for (const [k, v] of Object.entries(row?.properties ?? {})) {
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  console.log(`  ${k.padEnd(30)} ${s.slice(0, 150)}`);
}

// The decisive step: is originalSwaggerUrl actually fetchable, and does it carry the
// operations the agent calls? A URL we cannot GET is no better than no URL.
const defs = row?.properties?.apiDefinitions as { originalSwaggerUrl?: string } | undefined;
const swurl = defs?.originalSwaggerUrl;
console.log('\n── GET originalSwaggerUrl\n');
if (!swurl) {
  console.log('  absent');
} else {
  // Blob URLs carry a SAS token in the query string — never print the URL itself.
  const sr = await fetch(swurl);
  console.log(`  HTTP ${sr.status}`);
  if (sr.ok) {
    const doc = JSON.parse(await sr.text()) as {
      host?: string; basePath?: string; schemes?: string[];
      securityDefinitions?: Record<string, { type?: string; name?: string; in?: string }>;
      paths?: Record<string, Record<string, { operationId?: string; summary?: string }>>;
    };
    console.log(`  host:     ${doc.host}`);
    console.log(`  basePath: ${doc.basePath}   schemes: ${(doc.schemes ?? []).join(',')}`);
    console.log(`  security: ${Object.entries(doc.securityDefinitions ?? {}).map(([k, v]) => `${k}: ${v.type} ${v.in ?? ''} ${v.name ?? ''}`).join(' | ')}`);
    console.log('  operations:');
    for (const [pth, methods] of Object.entries(doc.paths ?? {})) {
      for (const [m, op] of Object.entries(methods)) {
        console.log(`    ${(op.operationId ?? '(no id)').padEnd(16)} ${m.toUpperCase().padEnd(6)} ${pth}`);
        console.log(`      summary:     ${op.summary ?? '(none)'}`);
        console.log(`      description: ${(op as { description?: string }).description ?? '(none)'}`);
      }
    }
  }
}
process.exit(0);
