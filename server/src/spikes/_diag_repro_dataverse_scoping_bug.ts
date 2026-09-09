/** Reproduce the exact connector-scoping computation orchestrator.ts does for the real
 *  staged Deal Desk agent, to find WHY Dataverse gets excluded despite matching ids.
 *  Read-only. npx tsx src/spikes/_diag_repro_dataverse_scoping_bug.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import { SURFACE_EQUIVALENTS } from '../db/repos/agentSurfaceChoice.js';

await connectMongo();
const row = await getDb()
  .collection('stagedAgents')
  .find({ name: 'Deal Desk' })
  .sort({ $natural: -1 })
  .limit(1)
  .next();
const ir = row?.mapped?.ir;

const usedConnectorIdsRaw = agentConnectorIds(ir);
console.log('usedConnectorIdsRaw:', [...usedConnectorIdsRaw]);

const surfaceBaseConnectorIds = new Set(
  Object.keys(SURFACE_EQUIVALENTS).map((k) => (k.includes(':') ? k.slice(0, k.indexOf(':')) : k)),
);
console.log('surfaceBaseConnectorIds:', [...surfaceBaseConnectorIds]);

const usedConnectorIds = new Set([...usedConnectorIdsRaw].filter((id) => !surfaceBaseConnectorIds.has(id)));
console.log('usedConnectorIds (final):', [...usedConnectorIds]);
console.log('\nDoes usedConnectorIds contain shared_commondataserviceforapps?', usedConnectorIds.has('shared_commondataserviceforapps'));
process.exit(0);
