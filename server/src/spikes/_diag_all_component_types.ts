/**
 * Dump ALL botcomponent types (not just type 16) for an agent — to find where
 * Confluence space selections or connection references are actually stored.
 *
 * Usage:
 *   cd server
 *   npx tsx src/spikes/_diag_all_component_types.ts "Confluence_agent"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const TARGET_NAME = process.argv[2] ?? 'Confluence_agent';
const SHOW_TYPE = process.argv[3] ? Number(process.argv[3]) : null; // optionally filter by type

interface BotComponent {
  botcomponentid: string;
  name: string;
  componenttype: number;
  data?: string;
  content?: string;
  schemaname?: string;
}

async function fetchAllComponents(orgUrl: string, token: string, botId: string): Promise<BotComponent[]> {
  const filter = `_parentbotid_value eq ${botId}`;
  const url =
    `${orgUrl}/api/data/v9.2/botcomponents` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$select=botcomponentid,name,componenttype,data,content,schemaname` +
    `&$top=500`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
  });
  if (!res.ok) throw new Error(`botcomponents ${res.status}: ${await res.text()}`);
  const j = await res.json() as { value?: BotComponent[] };
  return j.value ?? [];
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots: Awaited<ReturnType<typeof listBots>>;
    try { bots = await listBots(env.url, token); } catch { continue; }
    const bot = bots.find((b) => b.name.toLowerCase().includes(TARGET_NAME.toLowerCase()));
    if (!bot) continue;

    console.log(`\n✅ "${bot.name}" in "${env.name}"\n`);
    const comps = await fetchAllComponents(env.url, token, bot.botid);
    console.log(`Total: ${comps.length} botcomponents\n`);

    const toShow = SHOW_TYPE !== null ? comps.filter((c) => c.componenttype === SHOW_TYPE) : comps;

    for (const c of toShow) {
      const raw = c.data || c.content || '';
      const hasCf = raw.toLowerCase().includes('confluence');
      const marker = hasCf ? ' ← contains "confluence"' : '';
      console.log(`type=${c.componenttype}  name="${c.name}"${marker}`);
      if (c.schemaname) console.log(`  schemaname: ${c.schemaname}`);

      // For non-standard types or if it mentions confluence, show full raw
      if (c.componenttype !== 9 || hasCf) {
        if (raw) {
          console.log(`  raw (${raw.length} chars):`);
          raw.slice(0, 1200).split('\n').forEach((l) => console.log('  ' + l));
        } else {
          console.log('  (no data)');
        }
      }
      console.log();
    }
    process.exit(0);
  }
  console.error(`Agent "${TARGET_NAME}" not found.`);
  process.exit(1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
