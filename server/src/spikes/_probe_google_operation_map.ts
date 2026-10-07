/**
 * EVERY Google connector, EVERY operation, mapped to the real Google API method - or refused
 * with the reason, per operation.
 *
 * WHY PER OPERATION. Every Google number before this was per CONNECTOR, from 3 sample paths,
 * and that granularity is a lie for any connector that is not uniform. shared_googlecontacts
 * proved it live: 12 operations, 4 on GData (retired 2022) and 5 on the real People API. A
 * connector-level verdict is wrong for one half whichever way it goes - refuse and we drop
 * working operations, bind and we ship tools that 404.
 *
 * WHAT DECIDES. Google's Discovery document, not a path-shape guess. `baseUrl` + a method's
 * `path` is the full URL by Discovery's own contract, so an operation either IS one of the
 * API's methods or it is not. That single test covers the three things that were being
 * checked separately and badly:
 *
 *     /datasets/default/files/{id}   not a Discovery method  -> Power Platform abstraction
 *     /m8/feeds/contacts/default/full not a Discovery method -> retired API
 *     /users/me/calendarList/1        not a Discovery method -> PP filter convention, and
 *                                                               the one that returns the
 *                                                               WRONG calendar rather than
 *                                                               an error
 *     /trigger1/calendars/{id}/events not a Discovery method -> polling trigger
 *
 * The shape signals (dataset markers, the word `trigger`) are printed as an EXPLANATION of a
 * refusal Discovery already made. They never decide it. A hand-maintained list of
 * not-a-vendor-path shapes is always one shape behind - `/eventstarted/` and
 * `/people/trigger/` are both live here and both missed by the regex in operationBinding.ts.
 *
 *   cd server && npx tsx src/spikes/_probe_google_operation_map.ts
 *   cd server && npx tsx src/spikes/_probe_google_operation_map.ts --json out.json
 *
 * Reports only. Creates nothing, binds nothing. Needs MS_CLIENT_ID/MS_CLIENT_SECRET for the
 * live capture, and the Discovery cache written by _probe_name_to_api_call.py.
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveOpIndex, type CaptureContext } from '../connectors/captureOpIndex.js';
import { GOOGLE_APPS } from '../connectors/googleCatalog.js';

/**
 * Tenant, environment and scope come from the ENVIRONMENT, never from a literal.
 *
 * An earlier version of this probe hardcoded one tenant's GUIDs. That is fine for a one-off
 * measurement and useless as an answer: a customer installs a different set of connectors,
 * sometimes at different VERSIONS, which is exactly why captureOpIndex reads the swagger
 * from the customer's own environment rather than shipping one capture of ours. A result
 * from a hardcoded tenant is a sample, and reading it as a spec is how "9% bindable" becomes
 * a number nobody can act on.
 *
 *   CSGE_TENANT_ID=<entra tenant guid>  *   CSGE_ENV_URL=https://orgNNNN.crm.dynamics.com  *   CSGE_ENVIRONMENT_ID=<power platform environment guid>  *     npx tsx src/spikes/<this file>
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `${name} is not set. This probe reports on a CUSTOMER's environment and must be told ` +
      'which one; it has no default, deliberately. See the header for the three variables.',
    );
    process.exit(2);
  }
  return v;
}

const TENANT_ID = requireEnv('CSGE_TENANT_ID');
const ENV_URL = requireEnv('CSGE_ENV_URL');
const ENVIRONMENT_ID = requireEnv('CSGE_ENVIRONMENT_ID');
const ctx: CaptureContext = { tenantId: TENANT_ID, environmentId: ENVIRONMENT_ID, scope: `ms-${TENANT_ID}` };
const CACHE = join(tmpdir(), 'csge_discovery_cache');

/** The 8 Google connectors Copilot Studio offers, from docs/connector-api-index.json. */
const GOOGLE_CONNECTORS = [
  'shared_googledrive', 'shared_googlesheet', 'shared_googlecontacts', 'shared_googlecalendar',
  'shared_googlegemini', 'shared_googletasks', 'shared_googlepalm', 'shared_searchapigooglesearch',
];

interface DiscoMethod { id: string; httpMethod: string; url: string; segs: string[] }

/** Every method of one API as {id, verb, FULL url}. See the module docstring for why full. */
function discoveryMethods(api: string): DiscoMethod[] | null {
  const f = join(CACHE, `${api}.json`);
  if (!existsSync(f)) return null;
  const doc = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
  const base = String((doc.baseUrl ?? doc.rootUrl ?? '')).replace(/\/$/, '');
  const out: DiscoMethod[] = [];
  const walk = (node: Record<string, unknown>) => {
    for (const [, m] of Object.entries((node.methods ?? {}) as Record<string, Record<string, unknown>>)) {
      const path = String(m.flatPath ?? m.path ?? '');
      if (!path) continue;
      const url = `${base}/${path.replace(/^\//, '')}`;
      out.push({ id: String(m.id ?? ''), httpMethod: String(m.httpMethod ?? 'GET'), url, segs: segs(url) });
    }
    for (const [, sub] of Object.entries((node.resources ?? {}) as Record<string, Record<string, unknown>>)) walk(sub);
  };
  walk(doc);
  return out;
}

/** Placeholders collapse to `{}` so `{calendarId}` and `{+name}` compare equal. */
function segs(path: string): string[] {
  return path.replace(/\{[^}]*\}/g, '{}').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
}

function segsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === '{}' || b[i] === '{}' || s.toLowerCase() === b[i].toLowerCase());
}

/**
 * Why Discovery did not have this path. An EXPLANATION, never the verdict - see the module
 * docstring. Ordered most-specific first so `/v3/people/trigger/...` reads as a trigger
 * rather than as an unknown shape.
 */
function explain(path: string): string {
  if (/\/\$metadata\.json|\/datasets?\b|\/tables?\b/i.test(path)) return 'Power Platform dataset abstraction';
  if (/(^|\/)trigger\d*(\/|$)|eventstarted/i.test(path)) return 'Power Platform polling trigger';
  if (/\/m8\/feeds\//i.test(path)) return 'GData - Google retired this API in 2022';
  if (/\/\d+(\/|$)/.test(path)) return 'literal numeric segment - likely a PP filter convention, NOT a path';
  return 'no matching method in this API';
}

const apiFor = new Map(GOOGLE_APPS.map((a) => [a.id, a]));
const methodCache = new Map<string, DiscoMethod[] | null>();

interface Row {
  connectorId: string; operationId: string; method: string; path: string;
  verdict: string; api: string; discoveryId: string; detail: string;
}
const rows: Row[] = [];

for (const cid of GOOGLE_CONNECTORS) {
  const index = await resolveOpIndex(cid, ctx);
  if (!index) {
    rows.push({ connectorId: cid, operationId: '(all)', method: '', path: '', verdict: 'no-index',
      api: '', discoveryId: '', detail: 'swagger not retrievable from this environment, cache or fixtures' });
    continue;
  }
  const app = apiFor.get(cid);
  if (!app) {
    for (const [opId, op] of Object.entries(index.operations)) {
      rows.push({ connectorId: cid, operationId: opId, method: op.method,
        path: op.path.replace(/^\/\{connectionId\}/, ''), verdict: 'no-catalog-row', api: '', discoveryId: '',
        detail: 'connector is not in googleCatalog.ts, so there is no API or base URL to check against' });
    }
    continue;
  }
  if (!methodCache.has(app.api)) methodCache.set(app.api, discoveryMethods(app.api));
  const methods = methodCache.get(app.api);
  const base = app.baseUrlTemplate.replace(/\/$/, '');

  for (const [opId, op] of Object.entries(index.operations)) {
    const path = op.path.replace(/^\/\{connectionId\}/, '');
    const row: Row = { connectorId: cid, operationId: opId, method: op.method, path,
      verdict: '', api: app.api, discoveryId: '', detail: '' };
    if (!methods) {
      row.verdict = 'dead-api';
      row.detail = `'${app.api}' is not in Google's Discovery service`;
      rows.push(row); continue;
    }
    // Only the methods this base URL can actually reach. A baseUrl that prefixes none of
    // them is wrong, which is a different failure from a path that does not exist.
    const reachable = methods.filter((m) => m.url.startsWith(base + '/'));
    const want = segs(path);
    const hit = reachable.find((m) => segsMatch(want, segs(m.url.slice(base.length)))
      && m.httpMethod.toUpperCase() === op.method.toUpperCase());
    // A path that exists under a DIFFERENT verb is worth separating: it means the resource
    // is real and only the operation is not, which is a much smaller fix than a dead API.
    const verbMiss = !hit && reachable.find((m) => segsMatch(want, segs(m.url.slice(base.length))));
    if (hit) { row.verdict = 'bindable'; row.discoveryId = hit.id; row.detail = `${hit.httpMethod} ${hit.url}`; }
    else if (verbMiss) { row.verdict = 'verb-mismatch'; row.discoveryId = verbMiss.id;
      row.detail = `path exists but as ${verbMiss.httpMethod}, connector declares ${op.method}`; }
    else { row.verdict = 'not-in-api'; row.detail = explain(path); }
    rows.push(row);
  }
}

const jsonAt = process.argv.indexOf('--json');
if (jsonAt > -1 && process.argv[jsonAt + 1]) {
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify(rows, null, 1));
  console.log(`wrote ${rows.length} rows to ${process.argv[jsonAt + 1]}`);
}

console.log(`\n${GOOGLE_CONNECTORS.length} Google connectors, ${rows.length} operations\n`);
for (const cid of GOOGLE_CONNECTORS) {
  const mine = rows.filter((r) => r.connectorId === cid);
  if (!mine.length) continue;
  const ok = mine.filter((r) => r.verdict === 'bindable').length;
  console.log(`=== ${cid}  ${ok}/${mine.length} bindable  [api: ${mine[0].api || '-'}]`);
  for (const r of mine) {
    console.log(`   ${r.verdict.padEnd(15)}${r.operationId.padEnd(30)}${r.method.padEnd(7)}${r.path}`);
    if (r.verdict === 'bindable') console.log(`                  -> ${r.discoveryId}`);
    else console.log(`                  -> ${r.detail}`);
  }
  console.log('');
}

const by = new Map<string, number>();
for (const r of rows) by.set(r.verdict, (by.get(r.verdict) ?? 0) + 1);
console.log('TOTALS across every Google operation:');
for (const [v, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${v}`);
const b = rows.filter((r) => r.verdict === 'bindable');
console.log(`\nBINDABLE: ${b.length}/${rows.length} (${Math.round((b.length / rows.length) * 100)}%) across ` +
  `${new Set(b.map((r) => r.connectorId)).size} connector(s)`);
process.exit(0);
