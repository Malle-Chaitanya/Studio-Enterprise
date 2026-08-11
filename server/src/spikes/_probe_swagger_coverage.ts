/**
 * Can we mechanically reproduce EVERY connector operation the tenant actually uses?
 *
 * The registry hand-declares 34 connectors. The live census (_diag_connectors_by_agent)
 * shows the tenant uses ids that are NOT in it. This probe answers, per connector id:
 *   - does Power Apps return a swagger for it in this environment?
 *   - how many operations does that swagger declare?
 *   - are the operationIds we extracted from Dataverse present in it, verb + path and all?
 *
 * If the answer is yes across the board, the tool emitter can be generic and a new
 * connector costs a fixture, not a module. Read-only: GETs and token mints only.
 *
 * npx tsx src/spikes/_probe_swagger_coverage.ts [envUrl]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { detectKnowledgeConnectors } from '../services/knowledgeConnectorScan.js';
import { CONNECTOR_REGISTRY as CONNECTORS } from '../connectors/registry.js';

const ENV = process.argv[2] ?? 'https://org32322095.crm.dynamics.com';
const WRITE_FIXTURES = process.argv.includes('--fixtures');

await connectMongo();
const envRow = (await getDb()
  .collection('environmentsCache')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as { tenantId?: string; environments?: Array<{ url: string; id: string; name: string }> } | null;
if (!envRow?.tenantId) {
  console.error('No environmentsCache row — sign in through the UI once first.');
  process.exit(1);
}
const tenant = envRow.tenantId;
const base = ENV.replace(/\/$/, '');
const env = (envRow.environments ?? []).find((e) => e.url.replace(/\/$/, '') === base);
if (!env?.id) {
  console.error(`No cached environment id for ${base}`);
  process.exit(1);
}
console.log(`\n=== tenant ${tenant} - env ${env.name} (${env.id}) ===\n`);

// ── what the tenant actually uses, with the operations each agent calls ──────
const dvToken = await clientCredsToken(tenant, ENV);
const bots = (await listBots(ENV, dvToken)) as Array<{ botid: string; name: string }>;
const detected = (await detectKnowledgeConnectors(
  ENV,
  dvToken,
  bots.map((b) => b.botid),
  new Map(bots.map((b) => [b.botid, b.name])),
)) as Array<{ connectorId: string; operations?: string[]; agentNames?: string[]; unsupported?: boolean }>;

const usedOps = new Map<string, Set<string>>();
for (const d of detected) {
  const set = usedOps.get(d.connectorId) ?? new Set<string>();
  for (const op of d.operations ?? []) set.add(op);
  usedOps.set(d.connectorId, set);
}

const ids = [...new Set([...usedOps.keys(), ...CONNECTORS.map((c) => c.id)])].sort();
console.log(`probing ${ids.length} connector id(s): ${usedOps.size} used live, ${CONNECTORS.length} in registry\n`);

const paToken = await clientCredsToken(tenant, 'https://service.powerapps.com');
if (WRITE_FIXTURES) mkdirSync('src/connectors/fixtures', { recursive: true });

let okCount = 0;
let opsHit = 0;
let opsMiss = 0;
const missing: string[] = [];

for (const cid of ids) {
  const url =
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${cid}` +
    `?api-version=2016-11-01&$filter=environment eq '${env.id}'&$expand=swagger`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${paToken}` } });
  } catch (e) {
    console.log(`ERR  ${cid} - ${(e as Error).message}`);
    continue;
  }
  const used = [...(usedOps.get(cid) ?? [])];
  if (!res.ok) {
    console.log(`${res.status}  ${cid}${used.length ? `  (used: ${used.join(', ')})` : ''}`);
    missing.push(cid);
    continue;
  }
  const json = (await res.json()) as any;
  const sw = json.properties?.swagger;
  const ops = new Map<string, string>();
  for (const [p, verbs] of Object.entries<any>(sw?.paths ?? {})) {
    for (const [verb, o] of Object.entries<any>(verbs ?? {})) {
      if (o?.operationId) ops.set(o.operationId, `${verb.toUpperCase()} ${p}`);
    }
  }
  okCount++;
  const hits = used.filter((o) => ops.has(o));
  const misses = used.filter((o) => !ops.has(o));
  opsHit += hits.length;
  opsMiss += misses.length;
  const inReg = CONNECTORS.some((c) => c.id === cid) ? '' : '  [NOT in registry]';
  console.log(`ok   ${cid} - ${json.properties?.displayName ?? ''} - ${ops.size} ops${inReg}`);
  for (const o of hits) console.log(`       hit  ${o} -> ${ops.get(o)}`);
  for (const o of misses) console.log(`       MISS ${o}`);
  if (WRITE_FIXTURES && sw) {
    writeFileSync(`src/connectors/fixtures/${cid}.json`, JSON.stringify(sw, null, 2));
  }
}

console.log(
  `\nsummary: swagger for ${okCount}/${ids.length} ids; ` +
    `used operations resolved ${opsHit}, unresolved ${opsMiss}` +
    (missing.length ? `\nno swagger: ${missing.join(', ')}` : ''),
);
process.exit(0);
