/** EVERYTHING Dataverse gives us for one agent, with connector use called out.
 *
 *  Answers "does Copilot Studio expose a Jira connection on this agent, and can we
 *  see it?" — the three shapes a connector can take are a knowledge source
 *  (componenttype 16), an agent action / ConnectorTool (componenttype 9), and a
 *  Power Automate flow (environment-level, not on the bot). This dumps every
 *  component so none of them can hide.
 *
 *  Tenant comes from environmentsCache, so it works without a live session.
 *
 *  npx tsx src/spikes/_diag_agent_full_dump.ts <envUrl> <botId> [outFile]
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';

const ENV = process.argv[2]!.replace(/\/$/, '');
const BOT = process.argv[3]!;
const OUT = process.argv[4];

const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = (await mc
  .db(config.CSGE_DB)
  .collection('environmentsCache')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as { tenantId?: string } | null;
await mc.close();
if (!cached?.tenantId) throw new Error('no tenantId in environmentsCache — connect Microsoft once first');

const token = await clientCredsToken(cached.tenantId, ENV);
const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ENV}/api/data/v9.2/${path}`, { headers: auth });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const lines: string[] = [];
const say = (s = '') => { lines.push(s); console.log(s); };

// ── The bot itself ────────────────────────────────────────────────────────────
const bot = await get<Record<string, any>>(`bots(${BOT})`);
say(`═══ BOT ${bot.name} ═══`);
for (const k of ['botid', 'schemaname', 'statecode', 'publishedon', 'createdon', 'modifiedon', 'language', 'template']) {
  if (bot[k] !== undefined) say(`  ${k}: ${JSON.stringify(bot[k])}`);
}
const cfgLen = typeof bot.configuration === 'string' ? bot.configuration.length : 0;
say(`  configuration: ${cfgLen} chars`);
if (cfgLen) say(`  configuration RAW:\n${bot.configuration}`);

// ── Every component ───────────────────────────────────────────────────────────
const TYPE: Record<number, string> = {
  0: 'Topic', 1: 'Trigger', 2: 'Dialog', 3: 'Entity', 4: 'Variable', 5: 'Skill',
  6: 'Setting', 7: 'Language', 8: 'Publishing', 9: 'Action/Tool', 10: 'Component',
  11: 'Test', 12: 'FileAttachment', 13: 'Analytics', 14: 'Knowledge', 15: 'Card',
  16: 'KnowledgeSource', 17: 'Gpt', 18: 'AgentTool',
};

let url = `botcomponents?$filter=${encodeURIComponent(`_parentbotid_value eq ${BOT}`)}&$top=200`;
const rows: Array<Record<string, any>> = [];
for (;;) {
  const page = await get<{ value?: Array<Record<string, any>>; '@odata.nextLink'?: string }>(url);
  rows.push(...(page.value ?? []));
  const next = page['@odata.nextLink'];
  if (!next) break;
  url = next.split('/api/data/v9.2/')[1]!;
}

say(`\n═══ COMPONENTS: ${rows.length} ═══`);
const byType = new Map<number, number>();
for (const c of rows) byType.set(c.componenttype, (byType.get(c.componenttype) ?? 0) + 1);
for (const [t, n] of [...byType].sort((a, b) => a[0] - b[0])) {
  say(`  type ${t} (${TYPE[t] ?? '?'}): ${n}`);
}

// ── Connector evidence, the point of the exercise ─────────────────────────────
const CONNECTOR_RE = /connectorId|ConnectorTool|shared_[a-z0-9_]+|operationId|McpServer|mcp_server/gi;
say(`\n═══ CONNECTOR EVIDENCE ═══`);
let hits = 0;
for (const c of rows) {
  const blob = [c.data, c.content, c.schemaname, c.name].filter((v) => typeof v === 'string').join('\n');
  const found = [...new Set(blob.match(CONNECTOR_RE) ?? [])];
  if (!found.length) continue;
  hits++;
  say(`\n── type ${c.componenttype} (${TYPE[c.componenttype] ?? '?'}) · "${c.name ?? '(unnamed)'}"`);
  say(`   schemaname: ${c.schemaname ?? '-'}`);
  say(`   matched: ${found.join(', ')}`);
  for (const line of blob.split(/\r?\n/)) {
    if (/connectorId|operationId|ConnectorTool|shared_|McpServer/i.test(line)) say(`   > ${line.trim().slice(0, 300)}`);
  }
}
if (!hits) say('  (none — no connector reference in any component on this agent)');

// ── Full component bodies ─────────────────────────────────────────────────────
say(`\n═══ FULL COMPONENT DATA ═══`);
for (const c of rows) {
  say(`\n── type ${c.componenttype} (${TYPE[c.componenttype] ?? '?'}) · "${c.name ?? '(unnamed)'}" · schema=${c.schemaname ?? '-'}`);
  for (const field of ['data', 'content']) {
    const v = c[field];
    if (typeof v === 'string' && v.length) say(`   --- ${field} (${v.length} chars) ---\n${v}`);
  }
}

if (OUT) {
  writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`\n[written to ${OUT}]`);
}
process.exit(0);
