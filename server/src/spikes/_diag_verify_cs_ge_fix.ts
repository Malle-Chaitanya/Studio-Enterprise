import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { extractAgent, listBots } from '../services/dataverse.js';
import { assessAgent } from '../services/assess.js';

const AGENT_NAME = 'CS_GE Knowledge Test Agent';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e' }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const env = (s.environments ?? []).find((e) => e.name === 'CloudFuze Migration Test');
  if (!env) throw new Error('env not found');
  const token = await clientCredsToken(s.tenantId ?? '', env.url);
  const bots = await listBots(env.url, token);
  const bot = bots.find((b) => b.name === AGENT_NAME);
  if (!bot) throw new Error('bot not found');
  const ir = await extractAgent(env.url, token, bot);
  const actions = assessAgent(ir).knowledge?.actions ?? [];
  console.log('actions:', JSON.stringify(actions.map((a) => ({ title: a.title, strategy: a.strategy, target: a.target })), null, 2));
  const spActions = actions.filter((a) => a.target === 'sharepoint-connector' || a.target === 'onedrive-connector');
  console.log(`\nsharepoint/onedrive actions detected: ${spActions.length}`);
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
