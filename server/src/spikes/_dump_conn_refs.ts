/**
 * What do the connection references on TOPIC-EMBEDDED connector actions actually look like?
 *
 * `connectorIdFromConnectionReference` resolves them to `unifiedagent`, `incident` or
 * nothing — all three are wrong, and the operation is then dropped with no bound call and
 * no note. Fix the parser against the real strings, not against a guess about them.
 *
 * npx tsx src/spikes/_dump_conn_refs.ts [agent name fragment]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { parseTopicConnectorActions } from '../services/toolPayload.js';
import { connectorIdFromConnectionReference } from '../services/connectorRef.js';

const NAME = process.argv[2] ?? 'Quality Evaluation Agent';
const ENV = 'https://org32322095.crm.dynamics.com';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const token = await clientCredsToken(cache!.tenantId!, ENV);

const bot = (await listBots(ENV, token)).find((b) => b.name.toLowerCase().includes(NAME.toLowerCase()));
if (!bot) {
  console.error(`no agent matching "${NAME}"`);
  process.exit(1);
}
console.log(`agent: ${bot.name}\n`);

const res = await fetch(
  `${ENV}/api/data/v9.2/botcomponents?$filter=_parentbotid_value eq ${bot.botid} and componenttype eq 9&$select=name,data,content`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
);
const comps = ((await res.json()) as { value?: Array<{ name?: string; data?: string; content?: string }> }).value ?? [];

const seen = new Set<string>();
for (const comp of comps) {
  const payload = comp.data || comp.content || '';
  for (const a of parseTopicConnectorActions(payload)) {
    const key = `${a.connectionReference ?? '(none)'}|${a.operationId ?? '(none)'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`op:        ${a.operationId ?? '(none)'}`);
    console.log(`  raw ref: ${a.connectionReference ?? '(none)'}`);
    console.log(`  parsed:  ${a.connectionReference ? connectorIdFromConnectionReference(a.connectionReference) ?? '(undefined)' : '(no ref)'}`);
  }
}

// Also show the raw YAML around the first connector action, so the real field names are
// visible rather than inferred from the parser that is currently getting them wrong.
const withAction = comps.find((c) => /InvokeConnectorAction/.test(c.data || c.content || ''));
if (withAction) {
  const payload = withAction.data || withAction.content || '';
  const i = payload.indexOf('InvokeConnectorAction');
  console.log(`\n── raw payload around the first InvokeConnectorAction (${withAction.name}):\n`);
  console.log(payload.slice(Math.max(0, i - 400), i + 700));
}
process.exit(0);
