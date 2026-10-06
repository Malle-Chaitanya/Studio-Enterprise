/**
 * Index EVERY connector Copilot Studio can offer, and judge whether each one is migratable
 * without per-connector code.
 *
 * WHY THIS AND NOT THE ONES THAT EXIST. Three nearby things are already in the repo and none
 * of them answers this question today:
 *   - `_prep_export_connector_catalog.ts` pulls the live catalog but only its LABELS (id,
 *     display name, publisher, tier) -- no operations, so it cannot judge anything. It also
 *     writes to a teammate's Desktop path.
 *   - `_diag_classify_all_connectors.ts` has the right verdict logic but reads the Mongo
 *     `connectors` collection, so it answers only for the 280 rows someone populated once.
 *   - `_prep_populate_full_connector_registry.ts` is what populated those 280, from a list a
 *     human pasted -- and the ledger's own heading says it: "a hand-written list can only
 *     have gaps in connectors someone already thought of".
 *
 * This reads the environment's real catalogue, captures each connector's own swagger, and
 * classifies from ALL of its paths rather than a 15-row sample. No Mongo, so it runs with
 * Docker down.
 *
 * THE VERDICT THAT MATTERS. Stripping `/{connectionId}` off a captured path either leaves the
 * vendor's real path or it does not, and that single fact decides the entire cost of a
 * connector:
 *   vendor-path  -- the generic bound-tool path already in production handles it. Adding the
 *                   connector is ONE data fact (its real base URL). No code.
 *   proxy-only   -- the path is Microsoft's own dataset/table abstraction, which was built on
 *                   purpose and has no vendor path underneath. Needs a vendor catalogue AND a
 *                   name-to-method translation, i.e. real work per connector.
 * CHECKED AGAINST THE 12 COMMITTED FIXTURES before being trusted at scale, where
 * operationBinding.ts's VENDOR_BINDINGS already carries a hand-verified verdict. It agrees on
 * 11 of 12: HubSpot x3, Jira, Confluence, Teams, Dataverse and Power Platform Admin all score
 * 0% proxy and come back `vendor-path`; Google Drive 57%, OneDrive 75% and SharePoint 78% come
 * back `proxy-only`.
 *
 * IT DISAGREES ON ONE, AND IN THE OPTIMISTIC DIRECTION. `shared_office365` scores 27% and is
 * called `vendor-path`; the hand-written verdict is `proxy-only`. PROXY_PATTERNS catches its
 * `$metadata.json/datasets/...` paths but not its `/codeless/v1.0/...` ones, which are equally
 * un-callable against Graph. So the headline `vendor-path` count below is an UPPER BOUND, not
 * an estimate: a connector in that bucket is a candidate for the no-code path, not a
 * confirmed one. Treat a 1-in-12 optimistic error rate as the floor on how wrong it can be,
 * and confirm a connector's real base URL before counting it as done.
 *
 *   cd server && npx tsx src/spikes/_probe_connector_api_index.ts            # list only, cheap
 *   cd server && npx tsx src/spikes/_probe_connector_api_index.ts --swagger  # + classify
 *   cd server && npx tsx src/spikes/_probe_connector_api_index.ts --swagger --limit 40
 *
 * READ-ONLY: GETs against api.powerapps.com with the app-only token we already mint for
 * extraction. Creates nothing, writes nothing to Power Platform. The token is never printed.
 * Output goes to docs/connector-api-index.json, relative to the repo.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientCredsToken } from '../auth/microsoft.js';

const POWERAPPS_AUDIENCE = 'https://service.powerapps.com';

const argv = process.argv.slice(2);
const argOf = (f: string) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);

// The same tenant/environment the other spikes in this folder run against. Overridable so
// this is not pinned to one customer; see _prep_export_connector_catalog.ts for the origin.
const TENANT_ID = argOf('--tenant') ?? process.env.MS_TENANT_ID ?? '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENVIRONMENT_ID = argOf('--env') ?? process.env.PP_ENVIRONMENT_ID ?? '7f9f87cc-464e-e470-95bb-363b7f227200';

interface ApiRow {
  name?: string;
  properties?: { displayName?: string; publisher?: string; tier?: string; category?: string };
}

/**
 * Microsoft's generic structured-data abstraction, reused across every tabular backend
 * (Excel, SharePoint lists, SQL, Google Sheets, Smartsheet). Lifted verbatim from
 * _diag_classify_all_connectors.ts so the two cannot drift into different verdicts for the
 * same connector -- this repo's recurring bug is one fact with two implementations.
 */
const PROXY_PATTERNS = [/\/datasets\//i, /\/v2\/datasets\//i, /\/tables\/\{/i, /\/\$metadata\.json\/datasets/i];

type Verdict = 'vendor-path' | 'proxy-only' | 'uncertain' | 'no-operations';

function classify(paths: string[]): { verdict: Verdict; proxyRatio: number } {
  if (!paths.length) return { verdict: 'no-operations', proxyRatio: 0 };
  const stripped = paths.map((p) => p.replace(/^\/\{connectionId\}/, ''));
  const proxyRatio = stripped.filter((p) => PROXY_PATTERNS.some((re) => re.test(p))).length / stripped.length;
  if (proxyRatio >= 0.4) return { verdict: 'proxy-only', proxyRatio };
  const realApi = stripped.filter((p) => /\/[a-z][a-z0-9_-]{2,}/i.test(p) && !PROXY_PATTERNS.some((re) => re.test(p)));
  if (realApi.length / stripped.length >= 0.6) return { verdict: 'vendor-path', proxyRatio };
  return { verdict: 'uncertain', proxyRatio };
}

/** Bounded fan-out. An unbounded Promise.all at Power Platform is how a sweep gets throttled. */
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

interface IndexRow {
  connectorId: string;
  displayName: string;
  publisher: string;
  tier: string;
  category: string;
  operationCount?: number;
  verdict?: Verdict;
  proxyRatio?: number;
  /** Credential shapes the connector declares — what the customer would have to supply. */
  authTypes?: string[];
  samplePaths?: string[];
}

async function listConnectors(token: string): Promise<ApiRow[]> {
  const rows: ApiRow[] = [];
  let url: string | null =
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis?api-version=2016-11-01` +
    `&$filter=${encodeURIComponent(`environment eq '${ENVIRONMENT_ID}'`)}`;
  let page = 0;
  while (url) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`catalog list failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { value?: ApiRow[]; nextLink?: string };
    rows.push(...(json.value ?? []));
    url = json.nextLink ?? null;
    page++;
    process.stderr.write(`\r  listing... page ${page}, ${rows.length} connectors`);
  }
  process.stderr.write('\n');
  return rows;
}

async function captureSwagger(connectorId: string, token: string): Promise<{ paths: string[]; auth: string[] } | null> {
  const url =
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${encodeURIComponent(connectorId)}` +
    `?api-version=2016-11-01&$filter=${encodeURIComponent(`environment eq '${ENVIRONMENT_ID}'`)}&$expand=swagger`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null; // 404 = not installed here; information, not an error
    const body = (await res.json()) as { properties?: Record<string, unknown> };
    const props = body.properties ?? {};
    const sw = (props.swagger ?? {}) as { paths?: Record<string, unknown> };
    const cp = (props.connectionParameters ?? {}) as Record<string, { type?: string }>;
    return {
      paths: Object.keys(sw.paths ?? {}),
      auth: [...new Set(Object.values(cp).map((v) => v?.type).filter(Boolean) as string[])].sort(),
    };
  } catch {
    return null; // never throw a sweep into a failure; a missing row is reported as such
  }
}

const token = await clientCredsToken(TENANT_ID, POWERAPPS_AUDIENCE);
console.log(`environment ${ENVIRONMENT_ID}\n`);

const listed = await listConnectors(token);
const limit = Number(argOf('--limit') ?? 0);
const rows: IndexRow[] = listed.map((r) => ({
  connectorId: r.name ?? '',
  displayName: r.properties?.displayName ?? '',
  publisher: r.properties?.publisher ?? '',
  tier: r.properties?.tier ?? '',
  category: r.properties?.category ?? '',
}));

console.log(`CATALOG: ${rows.length} connectors offered in this environment\n`);
const byPublisher = new Map<string, number>();
for (const r of rows) byPublisher.set(r.publisher || '(none)', (byPublisher.get(r.publisher || '(none)') ?? 0) + 1);
console.log('  by publisher (top 10):');
for (const [p, n] of [...byPublisher.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${String(n).padStart(5)}  ${p}`);
}

if (!argv.includes('--swagger')) {
  console.log('\n  (labels only — re-run with --swagger to capture operations and classify)');
  process.exit(0);
}

const target = limit ? rows.slice(0, limit) : rows;
console.log(`\ncapturing swagger for ${target.length} connectors (bounded pool of 8)...`);
let done = 0;
await mapPool(target, 8, async (row) => {
  const cap = await captureSwagger(row.connectorId, token);
  done++;
  if (done % 25 === 0) process.stderr.write(`\r  captured ${done}/${target.length}`);
  if (!cap) return;
  const { verdict, proxyRatio } = classify(cap.paths);
  row.operationCount = cap.paths.length;
  row.verdict = verdict;
  row.proxyRatio = Number(proxyRatio.toFixed(2));
  row.authTypes = cap.auth;
  row.samplePaths = cap.paths.slice(0, 3).map((p) => p.replace(/^\/\{connectionId\}/, ''));
});
process.stderr.write('\n');

const judged = target.filter((r) => r.verdict);
const tally = new Map<Verdict, number>();
for (const r of judged) tally.set(r.verdict!, (tally.get(r.verdict!) ?? 0) + 1);

console.log(`\n${'='.repeat(78)}\nMIGRATABILITY — ${judged.length} connectors captured of ${target.length} asked\n`);
for (const v of ['vendor-path', 'proxy-only', 'uncertain', 'no-operations'] as Verdict[]) {
  const n = tally.get(v) ?? 0;
  console.log(`  ${v.padEnd(14)} ${String(n).padStart(4)}  ${judged.length ? ((n / judged.length) * 100).toFixed(0) : 0}%`);
}
const ops = judged.reduce((a, r) => a + (r.operationCount ?? 0), 0);
console.log(`\n  ${ops} operations indexed across them`);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'connector-api-index.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ environmentId: ENVIRONMENT_ID, capturedAt: new Date().toISOString(), rows: target }, null, 2));
console.log(`\nwrote ${out}`);
console.log('\n  vendor-path connectors need ONE data fact each (their real base URL) and no code.');
console.log('  proxy-only connectors need a vendor catalogue plus name-to-method translation,');
console.log('  which is the Google Drive problem — measured at roughly half the operations');
console.log('  resolving from names alone, so these are the expensive ones to count honestly.');
