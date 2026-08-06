/**
 * Dump raw Dataverse botcomponent data for a Confluence agent to answer:
 *   1. Are the Confluence space IDs present in the botcomponent?
 *   2. What `kind` string does Copilot Studio write for Confluence knowledge sources?
 *   3. Which fields / keys contain the space selection?
 *
 * Usage:
 *   cd server
 *   npx tsx src/spikes/_diag_confluence_raw.ts
 *   npx tsx src/spikes/_diag_confluence_raw.ts "My Confluence Agent"
 *
 * No arg: lists all agents across all connected envs so you can find the right name.
 * With name: dumps every knowledge-source botcomponent for that agent in full raw form.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const TARGET_NAME = process.argv[2] ?? '';

interface BotComponent {
  botcomponentid: string;
  name: string;
  componenttype: number;
  data?: string;
  content?: string;
  parentbotid?: string;
  createdon?: string;
  modifiedon?: string;
}

async function fetchBotComponents(orgUrl: string, token: string, botId: string): Promise<BotComponent[]> {
  // _parentbotid_value is the underlying lookup GUID column for the parentbotid navigation property
  const filter = `_parentbotid_value eq ${botId}`;
  const url =
    `${orgUrl}/api/data/v9.2/botcomponents` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$select=botcomponentid,name,componenttype,data,content,_parentbotid_value,createdon,modifiedon` +
    `&$top=200`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`botcomponents ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json() as { value?: BotComponent[] };
  return j.value ?? [];
}

/** Scan a string for Copilot Studio space ID patterns: {uuid}_{number} */
function findSpaceIds(text: string): string[] {
  const re = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+/gi;
  return [...new Set(text.match(re) ?? [])];
}

/** Recursively print all keys whose value contains a target string */
function findKeysWithValue(obj: unknown, contains: string, path = ''): void {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === 'string' && v.toLowerCase().includes(contains)) {
      console.log(`    KEY: ${p} = "${v.slice(0, 300)}"`);
    }
    findKeysWithValue(v, contains, p);
  }
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session found. Log in to the app first.');

  const envs = s.environments ?? [];
  if (envs.length === 0) throw new Error('No environments in session. Select an environment in the app first.');

  if (!TARGET_NAME) {
    // List mode: show all agents across all envs
    console.log('── Agents across all connected environments ─────────────────────────\n');
    for (const env of envs) {
      let token: string;
      try { token = await clientCredsToken(s.tenantId ?? '', env.url); }
      catch (e) { console.log(`  ${env.name}: token error — ${(e as Error).message}`); continue; }
      let bots: Awaited<ReturnType<typeof listBots>>;
      try { bots = await listBots(env.url, token); }
      catch (e) { console.log(`  ${env.name}: list error — ${(e as Error).message}`); continue; }
      console.log(`${env.name} (${env.url}) — ${bots.length} agents:`);
      bots.forEach((b, i) => console.log(`  ${i + 1}. ${b.name}`));
      console.log();
    }
    console.log('Re-run with the agent name as the first argument:');
    console.log(`  npx tsx src/spikes/_diag_confluence_raw.ts "Your Confluence Agent Name"`);
    return;
  }

  // Dump mode: find the agent and dump its knowledge source botcomponents
  for (const env of envs) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); }
    catch { continue; }

    let bots: Awaited<ReturnType<typeof listBots>>;
    try { bots = await listBots(env.url, token); }
    catch { continue; }

    const bot = bots.find((b) => b.name.toLowerCase() === TARGET_NAME.toLowerCase())
      ?? bots.find((b) => b.name.toLowerCase().includes(TARGET_NAME.toLowerCase()));
    if (!bot) continue;

    console.log(`\n✅ Found: "${bot.name}" in env "${env.name}"\n`);

    const components = await fetchBotComponents(env.url, token, bot.botid);
    console.log(`Total botcomponents: ${components.length}`);

    // Summary by type
    const byType = new Map<number, number>();
    for (const c of components) byType.set(c.componenttype, (byType.get(c.componenttype) ?? 0) + 1);
    for (const [type, count] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
      const label = type === 16 ? 'KnowledgeSource(16)' : type === 0 ? 'Bot(0)' : `type${type}`;
      console.log(`  ${label}: ${count}`);
    }

    // Knowledge sources
    const ksSources = components.filter((c) => c.componenttype === 16);
    console.log(`\n── Knowledge-source components (type 16): ${ksSources.length} ─────────────────\n`);

    for (const comp of ksSources) {
      console.log(`┌─ "${comp.name}"  id: ${comp.botcomponentid}`);

      const raw = comp.data || comp.content || '';
      if (!raw) { console.log('│  ⚠ empty (no data/content)\n└─\n'); continue; }

      console.log(`│  raw length: ${raw.length} chars`);
      console.log(`│  contains "confluence": ${raw.toLowerCase().includes('confluence') ? '✅ YES' : '✗ no'}`);

      const spaceIds = findSpaceIds(raw);
      console.log(`│  space ID pattern ({uuid}_{n}): ${spaceIds.length > 0 ? `✅ ${spaceIds.join(', ')}` : '✗ none found'}`);

      // Try to parse
      let parsed: unknown = null;
      let fmt = 'raw';
      try { parsed = JSON.parse(raw); fmt = 'JSON'; }
      catch {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const yaml = await import('js-yaml' as any);
          parsed = yaml.load(raw);
          fmt = 'YAML';
        } catch { /* stays raw */ }
      }
      console.log(`│  format: ${fmt}`);

      if (parsed) {
        console.log('│  keys containing "confluence":');
        findKeysWithValue(parsed, 'confluence');
        console.log('│');
        console.log('│  FULL PARSED DUMP:');
        JSON.stringify(parsed, null, 2).split('\n').forEach((l) => console.log('│    ' + l));
      } else {
        console.log('│  RAW (first 1500 chars):');
        raw.slice(0, 1500).split('\n').forEach((l) => console.log('│    ' + l));
      }
      console.log('└─\n');
    }

    // Any non-type-16 component mentioning confluence
    const otherCf = components.filter(
      (c) => c.componenttype !== 16 && (c.data ?? c.content ?? '').toLowerCase().includes('confluence'),
    );
    if (otherCf.length > 0) {
      console.log(`── Other components mentioning "confluence" (type != 16): ${otherCf.length} ──`);
      for (const c of otherCf) {
        console.log(`  type=${c.componenttype} name="${c.name}"`);
        const snip = (c.data ?? c.content ?? '').slice(0, 800);
        snip.split('\n').forEach((l) => console.log('    ' + l));
        console.log();
      }
    }

    process.exit(0);
  }

  console.error(`\n✗ Agent "${TARGET_NAME}" not found in any connected environment.`);
  console.error('Run without args to list available agents.');
  process.exit(1);
}

main().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
