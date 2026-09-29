/**
 * Pilot seed for the new `connectorCatalog` collection (see db/repos/connectorCatalog.ts).
 *
 * Scope, deliberately: Microsoft's own first-party connectors only, the ones already
 * captured for real in `connectorOpIndexes` from a live customer environment. This promotes
 * each one's already-real operation index into the new, pre-populated, per-connector (not
 * per-customer) catalog — no re-fetching, no invented data.
 *
 * If this pilot proves out, the same `putCatalogEntry` call is what widens to the full
 * connector catalog next — third-party connectors, then everything else.
 *
 * Run: npx tsx src/spikes/_prep_connector_catalog_pilot.ts
 */
import { connectDb, getDb, closeDb } from '../db/core.js';
import { putCatalogEntry, listCatalogEntries } from '../db/repos/connectorCatalog.js';
import { config } from '../config.js';

// Real Microsoft first-party connector ids, confirmed already captured for real in
// connectorOpIndexes from a live customer environment (2026-08-14 to 2026-09-20).
const MICROSOFT_FIRST_PARTY = [
  'shared_teams',
  'shared_microsoftcopilotstudio',
  'shared_conversionservice',
  'shared_sharepointonline',
  'shared_wordonlinebusiness',
  'shared_excelonlinebusiness',
  'shared_office365',
  'shared_commondataserviceforapps',
  'shared_onedriveforbusiness',
  'shared_agentnode',
];

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);

  let promoted = 0;
  let missing: string[] = [];

  for (const connectorId of MICROSOFT_FIRST_PARTY) {
    // Most recent real capture on file for this connector, across any customer environment.
    const row = await db
      .collection('connectorOpIndexes')
      .find({ connectorId })
      .sort({ capturedAt: -1 })
      .limit(1)
      .next();
    if (!row) {
      missing.push(connectorId);
      continue;
    }
    await putCatalogEntry(connectorId, row.index, 'microsoft-first-party', 'promoted-from-connectorOpIndexes');
    promoted++;
    console.log(`  + ${connectorId} — ${row.index.operationCount} operations`);
  }

  console.log(`\nPromoted ${promoted}/${MICROSOFT_FIRST_PARTY.length} Microsoft connectors into connectorCatalog.`);
  if (missing.length) console.log(`No existing capture on file for: ${missing.join(', ')}`);

  const all = await listCatalogEntries();
  console.log(`\nconnectorCatalog now holds ${all.length} entr${all.length === 1 ? 'y' : 'ies'}:`);
  for (const e of all) {
    console.log(`  - ${e.connectorId} (${e.source}): ${e.operationCount} ops, captured ${e.capturedAt.toISOString().slice(0, 10)}`);
  }

  await closeDb();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
