import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const saToken = await getSaToken(s?.gEmail || undefined);
  const project = '505103737920';

  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?pageSize=300`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`HTTP ${res.status}`);
  const body = await res.json() as { secrets?: { name: string }[] };
  const matches = (body.secrets ?? [])
    .map((sec) => sec.name.split('/').pop()!)
    .filter((name) => /calendar|googlecalendar/i.test(name));
  console.log(`Total secrets in project: ${body.secrets?.length ?? 0}`);
  console.log('Calendar-related secrets found:');
  for (const m of matches) console.log('  -', m);
  if (!matches.length) console.log('  (none — no calendar-related secret exists in this project at all)');

  // Also check connectorCredentials collection in Mongo — what does OUR app think it saved?
  const cc = await getDb().collection('connectorCredentials').find({ connectorId: 'shared_googlecalendar' }).toArray();
  console.log(`\nconnectorCredentials collection rows for shared_googlecalendar: ${cc.length}`);
  console.log(JSON.stringify(cc, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
