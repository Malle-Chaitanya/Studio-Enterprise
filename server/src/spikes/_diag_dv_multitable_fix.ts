/** Does resolveTableSearchTarget now return BOTH tables for a multi-table dvtablesearch source? */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveTableSearchTarget } from '../services/dataverseTableExport.js';

const ENV = process.argv[2]!;
const DV_TABLE_SEARCH_NAME = process.argv[3]!;

const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = (await mc
  .db(config.CSGE_DB)
  .collection('environmentsCache')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as { tenantId: string } | null;
await mc.close();
if (!cached) throw new Error('no cached tenant found');

const token = await clientCredsToken(cached.tenantId, ENV);
const r = await resolveTableSearchTarget(ENV, token, DV_TABLE_SEARCH_NAME);
console.log('unconfigured:', r.unconfigured);
console.log('targets     :', JSON.stringify(r.targets, null, 2));
console.log('count       :', r.targets.length);
process.exit(0);
