/** Does the Dataverse table resolver find the real tables behind the opaque key? */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveDataverseTables, resolvePrimaryKey } from '../services/dataverseTableExport.js';
const ENV = process.argv[2]!;
const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = await mc.db(config.CSGE_DB).collection('environmentsCache').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next() as any;
await mc.close();
const token = await clientCredsToken(cached.tenantId, ENV);

const r = await resolveDataverseTables(ENV, token, 'FAQ Entry, CF ICP Profile', ['FAQEntry_CFICPProfile_YDjONHProUWi_RE5Pmyu7']);
console.log(`resolved   : ${JSON.stringify(r.entitySetNames)}`);
console.log(`unresolved : ${JSON.stringify(r.unresolved)}`);
for (const es of r.entitySetNames) {
  const pk = await resolvePrimaryKey(ENV, token, es);
  console.log(`  ${es} -> primaryKey=${pk ?? 'NOT RESOLVED'}`);
}
process.exit(0);
