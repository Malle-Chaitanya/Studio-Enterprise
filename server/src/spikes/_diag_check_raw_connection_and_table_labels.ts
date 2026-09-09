/** Does the raw Dataverse payload for GetClientProfile capture the friendly "Connection"
 *  name ("Dataverse Deal Desk") or the friendly table label ("Client Credit Facility"),
 *  anywhere -- even if AgentToolIR doesn't currently surface them?
 *  npx tsx src/spikes/_diag_check_raw_connection_and_table_labels.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const db = getDb('csge');
const s = (await db
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId || !s.dvOrgUrl) throw new Error('NO_USABLE_SESSION');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const bots = await listBots(s.dvOrgUrl, token);
const bot = bots.find((b) => b.name.trim().toLowerCase() === 'deal desk');
if (!bot) throw new Error('Deal Desk not found');

// Fetch the raw botcomponent for GetClientProfile directly (schemaName from earlier dump).
const res = await fetch(
  `${s.dvOrgUrl}/api/data/v9.2/botcomponents?$filter=schemaname eq 'cr88d_DealDesk.action.MicrosoftDataverse-Listrowsfromselectedenvironment'&$select=name,schemaname,data`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
);
const json = (await res.json()) as { value?: { name: string; data: string }[] };
const raw = json.value?.[0]?.data ?? '(not found)';
console.log('=== RAW YAML/data for GetClientProfile ===');
console.log(raw);
process.exit(0);
