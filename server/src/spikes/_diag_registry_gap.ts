/**
 * `connectors/registry.ts` (REGISTRY_BY_ID) is what actually gates the Tier-2 generic
 * fallback tool today (buildLiveConnectorSpecsDetailed builds a live tool for ANY
 * connector present there, "regardless of readiness" — orchestrator.ts's own comment).
 * A connector missing from THAT list gets nothing at all — reported flatly `lost`, no
 * tool of any kind — regardless of what's in our new DB registry.
 *
 * This finds the real gap: which of our 280 captured connectors are missing from
 * REGISTRY_BY_ID, and therefore get zero tool today no matter how good their captured
 * operation data is.
 *
 * Run: npx tsx src/spikes/_diag_registry_gap.ts
 */
const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { REGISTRY_BY_ID } = await import('../connectors/registry.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  const dbConnectors = await db.collection('connectors').find({}).project({ connectorId: 1, displayName: 1, isMicrosoftOwnService: 1 }).toArray();
  console.log(`DB registry: ${dbConnectors.length} connectors`);
  console.log(`connectors/registry.ts (REGISTRY_BY_ID): ${REGISTRY_BY_ID.size} connectors\n`);

  const missing = dbConnectors.filter((c) => !REGISTRY_BY_ID.has(c.connectorId as string));
  const present = dbConnectors.filter((c) => REGISTRY_BY_ID.has(c.connectorId as string));

  console.log(`=== Present in registry.ts (gets a Tier-2 tool today): ${present.length} ===`);
  console.log(present.map((c) => c.connectorId).join(', '));

  console.log(`\n=== MISSING from registry.ts (gets NOTHING today — reported flatly 'lost'): ${missing.length} ===`);
  for (const c of missing) {
    console.log(`  ${c.connectorId} (${c.displayName}) — ${c.isMicrosoftOwnService ? 'MS-own' : 'third-party'}`);
  }

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
