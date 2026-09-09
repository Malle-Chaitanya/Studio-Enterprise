/** Live-verify the fix: the real GetRateSheetBand integration was deleted from Google
 *  (confirmed via console screenshot) but MongoDB still has a matching hash record.
 *  ensureFlowIntegration should now detect it's gone and recreate it, not skip.
 *  npx tsx src/spikes/_diag_verify_recreate_after_delete.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { translateFlow, integrationNameForFlow } from '../services/flowMapper.js';
import { getSaToken } from '../auth/google.js';
import { ensureFlowIntegration } from '../services/applicationIntegration.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
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
const ir = await extractAgent(s.dvOrgUrl, token, bot);
const flow = ir.flows?.find((f) => f.name === 'GetRateSheetBand');
if (!flow) throw new Error('GetRateSheetBand not found');

const mapped = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
const saToken = await getSaToken();
const appUserId = '6a5dfdff7cf05623332758b7';
const envUrl = s.dvOrgUrl;
const PROJECT = 'agentmigrations';

console.log('Calling ensureFlowIntegration on a flow whose Google resource is deleted but Mongo hash matches...');
const result = await ensureFlowIntegration(saToken, PROJECT, appUserId, envUrl, mapped);
console.log(JSON.stringify(result, null, 2));
console.log(`\nskippedUnchanged=${result.skippedUnchanged} (should be FALSE or undefined — it must have detected the deletion and recreated)`);
process.exit(0);
