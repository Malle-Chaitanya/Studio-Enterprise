/**
 * Corrected version of _diag_classify_all_connectors.ts: classifies PER OPERATION, not
 * per connector, after discovering Zendesk is a MIXED connector (32 abstraction-style
 * operations, 2 genuinely vendor-shaped) — a connector-level verdict hides that kind of
 * split. Reports real totals across all 5,121 captured operations.
 *
 * Run: npx tsx src/spikes/_diag_classify_all_operations.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

const PROXY_PATTERNS = [
  /\/datasets\//i,
  /\/v2\/datasets\//i,
  /\/tables\(/i,
  /\/tables\/\{/i,
  /\$metadata\.json/i,
];

function classifyPath(rawPath: string): 'vendor-shaped' | 'proxy-abstraction' {
  const stripped = rawPath.replace(/^\/\{connectionId\}/, '');
  return PROXY_PATTERNS.some((re) => re.test(stripped)) ? 'proxy-abstraction' : 'vendor-shaped';
}

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const allOps = await db.collection('connectorOperations').find({}).project({ connectorId: 1, operationId: 1, path: 1 }).toArray();
  console.log(`Classifying ${allOps.length} operations across all connectors...\n`);

  let vendorShaped = 0;
  let proxyAbstraction = 0;
  const perConnector = new Map<string, { vendor: number; proxy: number }>();

  for (const op of allOps) {
    const verdict = classifyPath(op.path as string);
    if (verdict === 'vendor-shaped') vendorShaped++;
    else proxyAbstraction++;
    const c = perConnector.get(op.connectorId as string) ?? { vendor: 0, proxy: 0 };
    if (verdict === 'vendor-shaped') c.vendor++; else c.proxy++;
    perConnector.set(op.connectorId as string, c);
  }

  console.log(`=== Totals across all ${allOps.length} operations ===`);
  console.log(`vendor-shaped (data-only fix works):    ${vendorShaped} (${((vendorShaped / allOps.length) * 100).toFixed(1)}%)`);
  console.log(`proxy-abstraction (needs real code):    ${proxyAbstraction} (${((proxyAbstraction / allOps.length) * 100).toFixed(1)}%)`);

  // Connectors that are MIXED — some real operations, some abstraction — same shape as
  // the Zendesk discovery. These are the ones a connector-level verdict would mislead on.
  const mixed = [...perConnector.entries()].filter(([, c]) => c.vendor > 0 && c.proxy > 0);
  console.log(`\n=== Mixed connectors (${mixed.length}) — some ops easy, some ops hard, within the SAME connector ===`);
  for (const [id, c] of mixed.sort((a, b) => b[1].proxy - a[1].proxy)) {
    console.log(`  ${id}: ${c.vendor} vendor-shaped, ${c.proxy} proxy-abstraction`);
  }

  // Purely proxy-abstraction connectors — every single operation needs real code.
  const pureProxy = [...perConnector.entries()].filter(([, c]) => c.vendor === 0 && c.proxy > 0);
  console.log(`\n=== Fully proxy-abstraction connectors (${pureProxy.length}) — every operation needs real code ===`);
  console.log(pureProxy.map(([id]) => id).join(', '));

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
