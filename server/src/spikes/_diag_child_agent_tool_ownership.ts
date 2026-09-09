/**
 * BLOCKING spike for the child-agent-tool-ownership design (decisions.md, 2026-08-31):
 * dump the real "Meeting Scheduler Agent" child-agent TOPIC component and its own 4
 * Outlook tool components side by side, in full, looking for ANY shared signal —
 * schemaname prefix, a field in the raw YAML, creation-time clustering — that could
 * tell extraction "these tools belong to that child agent" versus "these are just more
 * of the root agent's own tools."
 *
 * Read-only. No writes.
 *
 * Run: cd server && npx tsx src/spikes/_diag_child_agent_tool_ownership.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

interface BotComponent {
  botcomponentid: string;
  name: string;
  componenttype: number;
  data?: string;
  content?: string;
  schemaname?: string;
  createdon?: string;
  modifiedon?: string;
}

async function fetchAllComponents(orgUrl: string, token: string, botId: string): Promise<BotComponent[]> {
  const filter = `_parentbotid_value eq ${botId}`;
  const url =
    `${orgUrl}/api/data/v9.2/botcomponents` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$select=botcomponentid,name,componenttype,data,content,schemaname,createdon,modifiedon` +
    `&$top=500`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
  });
  if (!res.ok) throw new Error(`botcomponents ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { value?: BotComponent[] };
  return j.value ?? [];
}

function dump(c: BotComponent, label: string) {
  const raw = c.data || c.content || '';
  console.log(`\n--- ${label}: "${c.name}" ---`);
  console.log(`  botcomponentid: ${c.botcomponentid}`);
  console.log(`  componenttype: ${c.componenttype}`);
  console.log(`  schemaname: ${c.schemaname ?? '(none)'}`);
  console.log(`  createdon: ${c.createdon ?? '(none)'}`);
  console.log(`  modifiedon: ${c.modifiedon ?? '(none)'}`);
  console.log(`  raw (${raw.length} chars):`);
  console.log(raw || '  (empty)');
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session');

  for (const env of s.environments ?? []) {
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    let bots: Awaited<ReturnType<typeof listBots>>;
    try {
      bots = await listBots(env.url, token);
    } catch {
      continue;
    }
    const bot = bots.find((b) => b.name === 'WorkMate');
    if (!bot) continue;

    console.log(`found WorkMate in env "${env.name}"\n`);
    const comps = await fetchAllComponents(env.url, token, bot.botid);
    console.log(`Total: ${comps.length} botcomponents\n`);

    // The child-agent TOPIC itself.
    const topic = comps.find((c) => c.componenttype === 9 && c.name === 'Meeting Scheduler Agent');
    if (topic) dump(topic, 'CHILD-AGENT TOPIC');
    else console.log('!! Meeting Scheduler Agent topic component NOT FOUND by exact name match.');

    // Its 4 Outlook tool components, by known operationId (from the earlier live extraction).
    const targetOps = ['GetEventsCalendarViewV3', 'CalendarGetTables_V2', 'FindMeetingTimes_V2', 'V4CalendarPostItem'];
    const toolComps = comps.filter((c) => {
      const raw = c.data || c.content || '';
      return targetOps.some((op) => raw.includes(op));
    });
    console.log(`\nFound ${toolComps.length} tool component(s) matching the 4 target operationIds.`);
    for (const t of toolComps) dump(t, 'TOOL COMPONENT');

    // For comparison: one tool component that belongs to WorkMate's OWN pre-existing
    // tools (not the child agent), to see if there's a structural difference at all.
    const controlTool = comps.find((c) => {
      const raw = c.data || c.content || '';
      return c.componenttype === 9 && raw.includes('ListChats') && !targetOps.some((op) => raw.includes(op));
    });
    if (controlTool) dump(controlTool, 'CONTROL — pre-existing WorkMate tool (Teams)');

    process.exit(0);
  }
  console.error('WorkMate not found in any environment on this session.');
  process.exit(1);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
