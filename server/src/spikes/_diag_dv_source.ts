/** Raw YAML of the Dataverse-table knowledge source — where does the real table name live? */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
const ENV = process.argv[2]!, BOT = process.argv[3]!;
const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = await mc.db(config.CSGE_DB).collection('environmentsCache').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next() as any;
await mc.close();
const token = await clientCredsToken(cached.tenantId, ENV);
const r = await (await fetch(`${ENV}/api/data/v9.2/botcomponents?$select=name,data,content,componenttype,schemaname&$filter=${encodeURIComponent(`_parentbotid_value eq ${BOT} and componenttype eq 16`)}&$top=50`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })).json() as any;
for (const c of r.value ?? []) {
  console.log(`\n═══ "${c.name}" schema=${c.schemaname}`);
  if (c.data) console.log(`--- data ---\n${c.data}`);
  if (c.content) console.log(`--- content ---\n${c.content}`);
}
process.exit(0);
