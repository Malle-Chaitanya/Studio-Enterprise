/**
 * Dump EVERYTHING we can fetch from a Copilot Studio agent:
 *   - bot row itself (all fields)
 *   - all botcomponents (every type, full raw)
 *   - botcomponentcollections (if any)
 *   - PA flow connectionReferences (connector info)
 *   - botcomponent type legend
 *
 * Usage:
 *   cd server
 *   npx tsx src/spikes/_diag_full_agent_dump.ts "Confluence_agent"
 *   npx tsx src/spikes/_diag_full_agent_dump.ts   (lists agents)
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

const TARGET_NAME = process.argv[2] ?? '';

// Known componenttype codes
const TYPE_LABELS: Record<number, string> = {
  0:  'Bot (root)',
  1:  'Topic (dialog)',
  2:  'Trigger (intent)',
  3:  'Variable',
  4:  'Entity',
  5:  'Model (NLU)',
  6:  'Language',
  7:  'BotTranslation',
  8:  'SkillManifest',
  9:  'AdaptiveDialog (topic body)',
  10: 'FlowDeclaration',
  11: 'BotFileAttachment',
  12: 'Action / CustomAction',
  13: 'BotSkillDeclaration',
  14: 'FileAttachment',
  15: 'GptComponentMetadata (instructions)',
  16: 'KnowledgeSource',
  17: 'KnowledgeSourceConfiguration',
  18: 'AuthProviderConfig',
  19: 'PublishedBotConfig',
  20: 'ConversationTranscript',
};

function label(t: number) { return TYPE_LABELS[t] ?? `unknown(${t})`; }

async function dvGet(orgUrl: string, token: string, path: string): Promise<unknown> {
  const res = await fetch(`${orgUrl}/api/data/v9.2/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.include-annotations=*',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function section(title: string) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

function dump(obj: unknown, indent = 2) {
  console.log(JSON.stringify(obj, null, indent));
}

async function main() {
  await connectMongo();
  const s = (await getDb()
    .collection('migrationSessions')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as Session | null;
  if (!s) throw new Error('No session — log in to the app first.');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }

    let bots: Awaited<ReturnType<typeof listBots>>;
    try { bots = await listBots(env.url, token); } catch { continue; }

    if (!TARGET_NAME) {
      console.log(`\n${env.name} (${env.url}):`);
      bots.forEach((b, i) => console.log(`  ${i + 1}. ${b.name}`));
      continue;
    }

    const bot = bots.find((b) => b.name.toLowerCase() === TARGET_NAME.toLowerCase())
      ?? bots.find((b) => b.name.toLowerCase().includes(TARGET_NAME.toLowerCase()));
    if (!bot) continue;

    console.log(`\n✅  Agent: "${bot.name}"   env: "${env.name}"`);
    console.log(`    botid: ${bot.botid}`);

    // ── 1. Full bot row ─────────────────────────────────────────────────────
    section('1. FULL BOT ROW (all OData fields)');
    try {
      const botRow = await dvGet(env.url, token, `bots(${bot.botid})`);
      dump(botRow);
    } catch (e) { console.log('ERROR:', (e as Error).message); }

    // ── 2. All botcomponents ───────────────────────────────────────────────
    section('2. ALL BOTCOMPONENTS (every type)');
    let components: Array<Record<string, unknown>> = [];
    try {
      const r = await dvGet(
        env.url, token,
        `botcomponents?$filter=_parentbotid_value eq ${bot.botid}&$top=500`,
      ) as { value?: Array<Record<string, unknown>> };
      components = r.value ?? [];
    } catch (e) { console.log('ERROR:', (e as Error).message); }

    // Summary
    const byType = new Map<number, number>();
    for (const c of components) byType.set(c['componenttype'] as number, (byType.get(c['componenttype'] as number) ?? 0) + 1);
    console.log(`\nTotal: ${components.length} components`);
    for (const [t, n] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  ${label(t)}: ${n}`);
    }

    // Full dump per component
    for (const c of components) {
      const t = c['componenttype'] as number;
      const name = String(c['name'] ?? '');
      const id = String(c['botcomponentid'] ?? '');
      console.log(`\n── ${label(t)} ──────────────────────────────────────`);
      console.log(`   name: ${name}`);
      console.log(`   id:   ${id}`);
      if (c['schemaname']) console.log(`   schemaname: ${c['schemaname']}`);
      if (c['data']) {
        console.log(`   data (${(c['data'] as string).length} chars):`);
        String(c['data']).split('\n').forEach((l) => console.log('   ' + l));
      }
      if (c['content']) {
        console.log(`   content (${(c['content'] as string).length} chars):`);
        try {
          dump(JSON.parse(c['content'] as string));
        } catch {
          String(c['content']).split('\n').forEach((l) => console.log('   ' + l));
        }
      }
      // Print any other non-null fields
      for (const [k, v] of Object.entries(c)) {
        if (['botcomponentid','name','componenttype','data','content','schemaname',
             '@odata.etag','_parentbotid_value'].includes(k)) continue;
        if (v !== null && v !== undefined && v !== '') {
          console.log(`   ${k}: ${JSON.stringify(v)}`);
        }
      }
    }

    // ── 3. botcomponentcollections (groups / skills / etc) ─────────────────
    section('3. BOTCOMPONENTCOLLECTIONS');
    try {
      const r = await dvGet(
        env.url, token,
        `botcomponentcollections?$filter=_parentbotid_value eq ${bot.botid}&$top=50`,
      ) as { value?: unknown[] };
      if ((r.value ?? []).length === 0) {
        console.log('(none found)');
      } else {
        dump(r.value);
      }
    } catch (e) { console.log('(not available or error:', (e as Error).message + ')'); }

    // ── 4. PA flows referencing this bot / this env ─────────────────────────
    section('4. POWER AUTOMATE FLOWS (connectionReferences, category=5)');
    try {
      const r = await dvGet(
        env.url, token,
        `workflows?$filter=category eq 5&$select=workflowid,name,clientdata&$top=20`,
      ) as { value?: Array<{ workflowid: string; name: string; clientdata?: string }> };
      const flows = r.value ?? [];
      console.log(`${flows.length} flows found`);
      for (const f of flows) {
        console.log(`\n  Flow: "${f.name}" (${f.workflowid})`);
        if (f.clientdata) {
          try {
            const cd = JSON.parse(f.clientdata) as { properties?: { connectionReferences?: Record<string, unknown> } };
            const refs = cd.properties?.connectionReferences ?? {};
            if (Object.keys(refs).length) {
              console.log('  connectionReferences:');
              dump(refs);
            } else {
              console.log('  (no connectionReferences)');
            }
          } catch {
            console.log('  (clientdata not parseable)');
          }
        }
      }
    } catch (e) { console.log('(error:', (e as Error).message + ')'); }

    // ── 5. Connection references table ─────────────────────────────────────
    section('5. CONNECTIONREFERENCES TABLE');
    try {
      const r = await dvGet(
        env.url, token,
        `connectionreferences?$select=connectionreferenceid,connectionreferencedisplayname,connectorid,connectionid&$top=50`,
      ) as { value?: unknown[] };
      dump(r.value ?? []);
    } catch (e) { console.log('(not available:', (e as Error).message + ')'); }

    process.exit(0);
  }

  if (!TARGET_NAME) {
    console.log('\nRe-run with agent name:');
    console.log('  npx tsx src/spikes/_diag_full_agent_dump.ts "Confluence_agent"');
  } else {
    console.error(`\n✗ "${TARGET_NAME}" not found.`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
