/** Do Sales desk's bot-configuration flags now reach `unmapped`? Real payload, not a fixture. */
import { connectMongo } from '../db/mongo.js';
import { config } from '../config.js';
import { getDb } from '../db/core.js';

await connectMongo();
const raw = await getDb(config.CSGE_DB).collection('rawAgents')
  .findOne<{ botRecord?: { configuration?: string } }>({ sourceId: 'a521051e-5ca0-f111-aaad-0022480b19e9' });
const cfg = raw?.botRecord?.configuration;
if (!cfg) { console.log('no raw configuration'); process.exit(1); }

// parseAgentSettings is module-private; exercise it through the same JSON the extractor sees.
const mod = await import('../services/dataverse.js') as Record<string, unknown>;
void mod;
const o = JSON.parse(typeof cfg === 'string' ? cfg : JSON.stringify(cfg)) as Record<string, unknown>;
console.log('configuration keys:', Object.keys(o).join(', '));
process.exit(0);
