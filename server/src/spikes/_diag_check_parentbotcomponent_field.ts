import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const TOOL_IDS = {
  'Get calendar view of events (V3)': '98600eee-5401-41d5-b45e-1ddb8c78e6b7',
  'Get calendars (V2)': '8d769bf2-1d60-4084-9e6d-2dfa57e9266c',
  'Find meeting times (V2)': 'c50d5522-ec74-4e49-87c7-53e16e9ef722',
  'Create event (V4)': 'e2c16bb6-f90b-412e-821c-f75cdbeb6175',
};

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session');
  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots; try { bots = await listBots(env.url, token); } catch { continue; }
    if (!bots.find((b) => b.name === 'WorkMate')) continue;

    for (const [label, id] of Object.entries(TOOL_IDS)) {
      const url = `${env.url}/api/data/v9.2/botcomponents(${id})?$select=name,_parentbotcomponentid_value,_parentbotcomponentcollectionid_value`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.include-annotations="*"' },
      });
      console.log(`\n${label}: HTTP ${res.status}`);
      console.log(await res.text());
    }
    process.exit(0);
  }
  console.error('WorkMate not found.');
  process.exit(1);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
