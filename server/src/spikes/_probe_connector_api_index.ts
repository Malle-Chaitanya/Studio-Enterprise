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

/**
 * The app-only token, re-minted on demand.
 *
 * A sweep of 1313 connectors outlives a client-credentials token (~1h), and the third run
 * proved it in the clearest possible way: every connector up to catalogue index 893 captured,
 * every one from 894 to 1312 returned 401. Perfectly contiguous. 419 rows -- the last third of
 * the catalogue -- looked like "our app lacks permission on these" and were really "the token
 * we minted an hour ago had expired". A 401 is normally a fact and correctly not retried,
 * which is exactly why this one was invisible: the retry logic was right and the premise
 * underneath it had gone stale.
 */
let cachedToken: string | undefined;
async function freshToken(force = false): Promise<string> {
  if (!cachedToken || force) cachedToken = await clientCredsToken(TENANT_ID, POWERAPPS_AUDIENCE);
  return cachedToken;
}

/**
 * One GET, retrying only what retrying can fix.
 *
 * Shared by the catalogue listing and the per-connector capture ON PURPOSE. The retry was
 * added to the capture first and not the listing, and the very next run died on a 504 from
 * the listing itself -- the same defect twice because the fix lived in one of the two places
 * that needed it. Power Platform answers 502/504 under load on both calls; nothing about
 * either makes it exempt.
 *
 * Returns the Response on success, or the last status (0 = network-level failure).
 */
async function getWithRetry(url: string, tries = 5): Promise<Response | number> {
  let last = 0;
  let reminted = false;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${await freshToken()}` } });
      if (res.ok) return res;
      last = res.status;
      // A 401 part-way through a long sweep is an expired token far more often than a real
      // permission boundary. Re-mint once and try again; if it 401s on a FRESH token it is a
      // genuine authorization fact and reported as one.
      if (res.status === 401 && !reminted) {
        reminted = true;
        await freshToken(true);
        continue;
      }
      // 404 and other 4xx are facts about the connector, not about load. Do not retry them.
      if (res.status !== 429 && res.status < 500) return res.status;
    } catch {
      last = 0;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
  }
  return last;
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
  /** Why this row has no verdict. A transient failure is UNKNOWN, never "no operations". */
  missReason?: string;
}

async function listConnectors(): Promise<ApiRow[]> {
  const rows: ApiRow[] = [];
  let url: string | null =
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis?api-version=2016-11-01` +
    `&$filter=${encodeURIComponent(`environment eq '${ENVIRONMENT_ID}'`)}`;
  let page = 0;
  while (url) {
    const res = await getWithRetry(url);
    if (typeof res === 'number') throw new Error(`catalog list failed after retries: ${res || 'network'}`);
    const json = (await res.json()) as { value?: ApiRow[]; nextLink?: string };
    rows.push(...(json.value ?? []));
    url = json.nextLink ?? null;
    page++;
    process.stderr.write(`\r  listing... page ${page}, ${rows.length} connectors`);
  }
  process.stderr.write('\n');
  return rows;
}

type CaptureResult =
  | { ok: true; paths: string[]; auth: string[] }
  | { ok: false; status: number; why: 'not-installed' | 'transient' | 'error' };

/**
 * One connector's swagger, retrying the failures that are about LOAD rather than the
 * connector.
 *
 * The first version of this returned `null` for any non-200, which collapsed two completely
 * different facts into one: a 404 ("not installed in this environment" -- real information)
 * and a 502/504 ("the gateway gave up" -- says nothing at all). Under a pool of 8 the sweep
 * took 706 of 1313 connectors as uncapturable and reported 92% vendor-path from what was
 * left. Both numbers were wrong, and the error was not random: the BIGGEST connectors are the
 * slowest to expand, so SharePoint (130 paths) and Office 365 (143) timed out while small
 * ones succeeded -- and those are precisely the known proxy-only ones. Dropping them silently
 * is what made the result look good. Asked one at a time afterwards, shared_googledrive and
 * shared_sharepointonline both answer 200.
 *
 * So: retry 429/5xx with backoff, and report WHY a row is missing instead of discarding it.
 */
async function captureSwagger(connectorId: string): Promise<CaptureResult> {
  const url =
    `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${encodeURIComponent(connectorId)}` +
    `?api-version=2016-11-01&$filter=${encodeURIComponent(`environment eq '${ENVIRONMENT_ID}'`)}&$expand=swagger`;
  const res = await getWithRetry(url);
  if (typeof res === 'number') {
    if (res === 404) return { ok: false, status: 404, why: 'not-installed' };
    return { ok: false, status: res, why: res >= 500 || res === 429 || res === 0 ? 'transient' : 'error' };
  }
  const body = (await res.json()) as { properties?: Record<string, unknown> };
  const props = body.properties ?? {};
  const sw = (props.swagger ?? {}) as { paths?: Record<string, unknown> };
  const cp = (props.connectionParameters ?? {}) as Record<string, { type?: string }>;
  return {
    ok: true,
    paths: Object.keys(sw.paths ?? {}),
    auth: [...new Set(Object.values(cp).map((v) => v?.type).filter(Boolean) as string[])].sort(),
  };
}

await freshToken();
console.log(`environment ${ENVIRONMENT_ID}\n`);

const listed = await listConnectors();
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
// Pool of 4, not 8. The earlier sweep at 8 produced 502/504 on more than half the catalogue;
// a sweep that cannot read the biggest connectors measures the small ones and calls it a
// census.
console.log(`\ncapturing swagger for ${target.length} connectors (bounded pool of 4, retrying 5xx)...`);
let done = 0;
const missed = { 'not-installed': 0, transient: 0, error: 0 };
await mapPool(target, 4, async (row) => {
  const cap = await captureSwagger(row.connectorId);
  done++;
  if (done % 25 === 0) process.stderr.write(`\r  captured ${done}/${target.length}`);
  if (!cap.ok) {
    missed[cap.why]++;
    row.missReason = `${cap.why}${cap.status ? ` (${cap.status})` : ''}`;
    return;
  }
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

console.log(`\n${'='.repeat(78)}`);
console.log(`COVERAGE — ${judged.length} of ${target.length} captured`);
console.log(`  not-installed in this environment : ${missed['not-installed']}`);
console.log(`  still failing after 4 tries       : ${missed.transient}   <- unknown, NOT absent`);
console.log(`  other error                       : ${missed.error}`);
console.log(`\nMIGRATABILITY — of the ${judged.length} actually read\n`);
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
