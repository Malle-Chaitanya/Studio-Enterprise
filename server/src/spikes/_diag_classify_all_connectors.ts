/**
 * Classifies all 280 registry connectors into:
 *   - vendor-path-likely  : stripping {connectionId} plausibly yields the vendor's real
 *                           API path (like Twilio/Jira/Dropbox) — fixable with ONE data
 *                           fact (real base URL), no per-connector code.
 *   - proxy-only-likely   : the path matches Microsoft's own generic "dataset/table"
 *                           abstraction (the same pattern already confirmed proxy-only
 *                           for Google Drive/OneDrive/Office 365/SharePoint) — no base
 *                           URL fixes this; it needs real hand-written translation code.
 *   - uncertain           : neither pattern clearly matches — needs a human/LLM look,
 *                           not a confident automatic call.
 *
 * This is a heuristic first pass over REAL captured paths, not a guess about connectors
 * we haven't looked at — every verdict is grounded in that connector's own stored
 * operations. Flagged as "uncertain" rather than forced into a bucket when unclear.
 *
 * Run: npx tsx src/spikes/_diag_classify_all_connectors.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

// Microsoft's own generic "structured data" abstraction — reused across many connectors
// for tabular/dataset-shaped backends (Excel, SharePoint lists, SQL-like sources, Google
// Sheets, Smartsheet, etc.), and already CONFIRMED proxy-only for Drive/OneDrive/
// Office365/SharePoint in VENDOR_BINDINGS's own proxyReason text. A connector whose paths
// are dominated by this shape has no real vendor path underneath — Microsoft built the
// abstraction on purpose, not out of necessity, so no vendor base URL can ever unwrap it.
const PROXY_PATTERNS = [
  /\/datasets\//i,
  /\/v2\/datasets\//i,
  /\/tables\/\{/i,
  /\/\$metadata\.json\/datasets/i,
];

// A REST path is "vendor-shaped" when it names a specific resource noun (not a generic
// dataset/table placeholder) and doesn't rely on Microsoft's structured-data abstraction.
function classifyConnector(paths: string[]): 'vendor-path-likely' | 'proxy-only-likely' | 'uncertain' {
  if (!paths.length) return 'uncertain';
  const stripped = paths.map((p) => p.replace(/^\/\{connectionId\}/, ''));
  const proxyHits = stripped.filter((p) => PROXY_PATTERNS.some((re) => re.test(p)));
  const proxyRatio = proxyHits.length / stripped.length;
  if (proxyRatio >= 0.4) return 'proxy-only-likely';
  // A vendor-path connector's stripped paths still look like a real, specific REST API —
  // multiple distinct non-generic segments, not just parameter placeholders.
  const looksLikeRealApi = stripped.filter((p) => /\/[a-z][a-z0-9_-]{2,}/i.test(p) && !PROXY_PATTERNS.some((re) => re.test(p)));
  if (looksLikeRealApi.length / stripped.length >= 0.6) return 'vendor-path-likely';
  return 'uncertain';
}

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const connectors = await db.collection('connectors').find({}).sort({ connectorId: 1 }).toArray();
  console.log(`Classifying ${connectors.length} connectors...\n`);

  const results = { 'vendor-path-likely': [] as string[], 'proxy-only-likely': [] as string[], uncertain: [] as string[] };

  for (const c of connectors) {
    const ops = await db
      .collection('connectorOperations')
      .find({ connectorId: c.connectorId })
      .limit(15)
      .project({ path: 1 })
      .toArray();
    const paths = ops.map((o: any) => o.path as string);
    const verdict = classifyConnector(paths);
    results[verdict].push(c.connectorId);
  }

  console.log(`=== vendor-path-likely (data-only fix): ${results['vendor-path-likely'].length} ===`);
  console.log(results['vendor-path-likely'].join(', '));
  console.log(`\n=== proxy-only-likely (needs real code): ${results['proxy-only-likely'].length} ===`);
  console.log(results['proxy-only-likely'].join(', '));
  console.log(`\n=== uncertain (needs a closer look): ${results.uncertain.length} ===`);
  console.log(results.uncertain.join(', '));

  console.log(`\n=== Totals ===`);
  console.log(`vendor-path-likely: ${results['vendor-path-likely'].length}`);
  console.log(`proxy-only-likely: ${results['proxy-only-likely'].length}`);
  console.log(`uncertain: ${results.uncertain.length}`);
  console.log(`total: ${connectors.length}`);

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
