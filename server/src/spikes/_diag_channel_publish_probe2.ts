/** Live probe: channels for Migrate Advisor + Enterprise Agent.
 *  Read-only. npx tsx src/spikes/_diag_channel_publish_probe2.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

interface EnvCacheRow {
  tenantId: string;
  environments: { name: string; url: string; accessible: boolean }[];
}

const TARGETS = ['Migrate Advisor', 'Enterprise Agent'];

async function main() {
  await connectMongo();
  const row = await getDb()
    .collection<EnvCacheRow>('environmentsCache')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next();
  if (!row) throw new Error('no environmentsCache entry');

  const env = row.environments.find((e) => /migration hub/i.test(e.name)) ?? row.environments[0];
  const token = await clientCredsToken(row.tenantId, env.url);

  const listRes = await fetch(
    `${env.url}/api/data/v9.2/bots?$select=name,botid&$filter=statecode eq 0`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  const list = (await listRes.json()) as { value: { name: string; botid: string }[] };

  for (const name of TARGETS) {
    const bot = list.value.find((b) => b.name === name);
    if (!bot) { console.log(`--- ${name}: NOT FOUND ---\n`); continue; }
    console.log(`=== ${name} (${bot.botid}) ===`);
    const res = await fetch(
      `${env.url}/api/data/v9.2/bots(${bot.botid})?$select=configuration,applicationmanifestinformation,publishedon,statecode`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    const body = (await res.json()) as Record<string, unknown>;
    console.log(`status: ${res.status}`);
    console.log(`publishedon: ${body.publishedon}  statecode: ${body.statecode}`);
    try {
      const cfg = JSON.parse(body.configuration as string);
      console.log('channels:', JSON.stringify(cfg.channels));
    } catch {
      console.log('configuration: (unparseable or missing)', body.configuration);
    }
    try {
      const manifest = JSON.parse(body.applicationmanifestinformation as string);
      console.log('copilotChat.isEnabled:', manifest?.copilotChat?.isEnabled);
      console.log('microsoft365.appId:', manifest?.microsoft365?.appId);
    } catch {
      console.log('applicationmanifestinformation: (unparseable or missing)');
    }
    console.log();
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
