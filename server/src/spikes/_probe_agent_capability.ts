/** What a source Copilot agent can actually DO: topics, tools, connectors, auth mode.
 *  Read-only app-only Dataverse. Used to design a demo around real capability. */
import { clientCredsToken } from '../auth/microsoft.js';
import { connectionAuthModeFrom } from '../services/connectorRef.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const NAMES = (process.env.NAMES || 'Deal Desk,WorkMate').split(',').map((s) => s.trim());
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
const api = `${ORG}/api/data/v9.2`;

const br = await fetch(`${api}/bots?$select=botid,name,schemaname&$filter=statecode eq 0`, { headers: h });
const bots = (JSON.parse(await br.text()).value ?? []) as { botid: string; name: string }[];

for (const want of NAMES) {
  const bot = bots.find((b) => (b.name ?? '').toLowerCase() === want.toLowerCase())
    ?? bots.find((b) => (b.name ?? '').toLowerCase().includes(want.toLowerCase()));
  if (!bot) { console.log(`\n### ${want}: not found`); continue; }
  console.log(`\n######## ${bot.name}  (${bot.botid})`);
  const cr = await fetch(
    `${api}/botcomponents?$select=name,componenttype,data&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid}`,
    { headers: h },
  );
  const comps = (JSON.parse(await cr.text()).value ?? []) as { name: string; componenttype: number; data?: string }[];
  const byType = new Map<number, string[]>();
  for (const c of comps) {
    if (!byType.has(c.componenttype)) byType.set(c.componenttype, []);
    byType.get(c.componenttype)!.push(c.name);
  }
  const TYPE: Record<number, string> = { 0: 'Topic', 9: 'Tool/Action', 10: 'Knowledge', 13: 'Trigger' };
  for (const [t, names] of [...byType].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${TYPE[t] ?? `type${t}`} (${names.length}): ${names.slice(0, 25).join(', ')}`);
  }
  console.log('  --- tools/actions detail ---');
  for (const c of comps.filter((c) => c.componenttype === 9)) {
    const data = `${c.data ?? ''}`;
    const conns = [...new Set(data.match(/shared_[a-zA-Z0-9_-]+/g) ?? [])];
    console.log(`    ${(c.name ?? '').padEnd(34)} auth=${connectionAuthModeFrom(data) ?? '-'}  conn=${conns.join(',') || '(none)'}`);
  }
}
process.exit(0);
