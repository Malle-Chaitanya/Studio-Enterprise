/**
 * Proves every always-on operation seeded tonight actually resolves to a real, callable
 * operation via `bindAlwaysOnOperations` — the same proof shape as
 * _test_catalog_bind_google_connectors.ts, for the bonus capabilities with no Microsoft
 * source equivalent at all.
 *
 *   npx tsx src/spikes/_test_always_on_bind.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { bindAlwaysOnOperations } from '../connectors/catalogBinding.js';

await connectMongo();

const CONNECTOR_IDS = [
  'shared_googledrive',
  'shared_googlecalendar',
  'shared_googlecontacts',
  'shared_gmail',
];

let total = 0;
for (const connectorId of CONNECTOR_IDS) {
  const results = await bindAlwaysOnOperations(connectorId);
  console.log(`\n${connectorId}: ${results.length} always-on operation(s)`);
  for (const { displayName, operation } of results) {
    console.log(`  ${displayName} — ${operation.method} ${operation.chain ? `[chain, ${operation.chain.length} step(s)]` : operation.urlTemplate}`);
  }
  total += results.length;
}

console.log(`\n\nTotal always-on operations bound: ${total}`);
process.exit(0);
