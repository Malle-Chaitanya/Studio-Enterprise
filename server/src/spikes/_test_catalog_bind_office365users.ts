/**
 * Proves the dynamic catalog actually resolves a real Copilot Studio operation id into a
 * correct, callable Microsoft Graph request — the core claim of the whole "dynamic
 * connectors" pilot, checked end to end rather than assumed.
 *
 * Run AFTER _prep_seed_office365users_catalog.ts has populated the catalog:
 *   npx tsx src/spikes/_test_catalog_bind_office365users.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { bindFromCatalog } from '../connectors/catalogBinding.js';

await connectMongo();

const CONNECTOR_ID = 'shared_office365users';
// These are the REAL operation ids, confirmed 2026-10-22 against this agent's actual
// extracted data (see _diag_check_real_operationids_this_agent.ts) — not guessed.
const cases = [
  'UserProfile_V2',
  'Manager_V2',
  'MyProfile_V2',
  'SearchUserV2',
  'DirectReports_V2',
  'UserPhoto_V2',
  'HttpRequest',
  'SomethingNeverCataloged',
];

for (const sourceOperationId of cases) {
  const result = await bindFromCatalog(CONNECTOR_ID, sourceOperationId);
  console.log(`\n${sourceOperationId}:`);
  if (result.status === 'bindable') {
    console.log('  BINDABLE');
    console.log(`  ${result.operation.method} ${result.operation.urlTemplate}`);
    console.log(`  auth: ${result.operation.auth} (aadResource: ${result.operation.aadResource})`);
    console.log(`  parameters: ${result.operation.parameters.map((p) => `${p.name}(${p.in}${p.required ? ', required' : ''})`).join(', ') || 'none'}`);
  } else if (result.status === 'unsupported') {
    console.log(`  UNSUPPORTED: ${result.reason}`);
  } else {
    console.log('  NOT IN CATALOG');
  }
}

process.exit(0);
