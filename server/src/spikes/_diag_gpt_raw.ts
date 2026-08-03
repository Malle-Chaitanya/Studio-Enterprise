/** Dump the raw type-15 (GptComponentMetadata) data + search for the description. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

const [ENV, BOTID] = process.argv.slice(2);

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
  const token = await clientCredsToken(s!.tenantId!, ENV);
  const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const comps = (await (await fetch(`${ENV}/api/data/v9.2/botcomponents?$select=name,data,componenttype&$filter=_parentbotid_value eq ${BOTID} and componenttype eq 15`, { headers: h })).json()) as { value?: { name?: string; data?: string }[] };
  for (const c of comps.value ?? []) {
    const raw = c.data ?? '';
    console.log(`\n===== type-15 "${c.name}" (${raw.length} chars) =====`);
    console.log('contains "CloudFuze":', /cloudfuze/i.test(raw), ' | "helper":', /helper/i.test(raw), ' | "description":', /description/i.test(raw));
    console.log('--- first 1500 chars ---');
    console.log(raw.slice(0, 1500));
    const at = raw.search(/cloudfuze|helper/i);
    if (at >= 0) console.log(`\n--- around description match (@${at}) ---\n`, raw.slice(Math.max(0, at - 120), at + 120));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
