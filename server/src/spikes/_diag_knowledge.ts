/**
 * Read-only knowledge diagnostic. Reveals (1) WHERE uploaded files live (which
 * botcomponent type we're not discovering) and (2) the REAL `kind` token of each
 * knowledge source, so we can fix discovery + classification against real data.
 *
 *   npx tsx src/_diag_knowledge.ts ["agent name substring"] [sessionId]
 *
 * If sessionId is omitted, the most recently created session is used.
 * Touches Copilot Studio READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { parse as parseYaml } from 'yaml';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { clientCredsToken } from './auth/microsoft.js';
import { classifyKnowledgeSource } from './services/knowledgeClassifier.js';

const NAME_MATCH = (process.argv[2] || 'service operations').toLowerCase();
const SESSION_ID = process.argv[3];

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

function refsFrom(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (typeof v === 'string' && v.trim() && /url|site|siteurl|reference|entity|path|connection/i.test(k)) out.push(v.trim());
        walk(v);
      }
    }
  };
  walk(doc);
  return [...new Set(out)];
}

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found — pass a sessionId, or connect via the web app first');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots;
    try { bots = await dvGet(env.url, token, `bots?$select=name,botid&$filter=statecode eq 0`); } catch { continue; }
    const bot = bots.value.find((b) => String(b.name ?? '').toLowerCase().includes(NAME_MATCH));
    if (!bot) continue;

    console.log(`\n=== ${bot.name} (env: ${env.name}) ===`);
    const comps = (await dvGet(
      env.url, token,
      `botcomponents?$select=name,componenttype,data&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid}&$top=1000`,
    )).value;

    // 1. Every component type present, with counts — reveals the type we miss.
    const byType = new Map<number, { count: number; names: string[] }>();
    for (const c of comps) {
      const t = Number(c.componenttype);
      const e = byType.get(t) ?? { count: 0, names: [] };
      e.count++;
      if (e.names.length < 8) e.names.push(String(c.name ?? ''));
      byType.set(t, e);
    }
    console.log('\n--- component types present (type 16 = KnowledgeSource we currently read) ---');
    for (const [t, e] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  type ${t}: ${e.count}  e.g. ${e.names.join(', ')}`);
    }

    // 2. Any component that looks like an uploaded file (extension / filedata).
    console.log('\n--- components that look like FILES (uploaded knowledge?) ---');
    let fileHits = 0;
    for (const c of comps) {
      const name = String(c.name ?? '');
      const data = String(c.data ?? '');
      if (/\.(pdf|docx?|pptx?|xlsx?|txt|csv|md|html?)$/i.test(name) || /filedata|filename|fileattachment|attachment/i.test(data)) {
        fileHits++;
        console.log(`  [type ${c.componenttype}] "${name}" (data ${data.length} chars)`);
        console.log('    ' + data.slice(0, 300).replace(/\n/g, '\n    '));
      }
    }
    if (!fileHits) console.log('  (none found among botcomponents — files may be in a separate table, e.g. annotations/msdyn_*)');

    // 3. Every type-16 KnowledgeSource: real kind + our classification.
    console.log('\n--- type-16 KnowledgeSource components: real kind → classification ---');
    for (const c of comps.filter((x) => Number(x.componenttype) === 16)) {
      const data = String(c.data ?? '');
      let doc: Record<string, unknown> | null = null;
      try { doc = parseYaml(data) as Record<string, unknown>; } catch { /* keep raw */ }
      const kind = (doc?.kind as string) ?? (doc?.knowledgeSourceType as string) ?? '(no kind field)';
      const references = doc ? refsFrom(doc) : [];
      const cls = classifyKnowledgeSource({ kind: String(kind), references });
      console.log(`\n  "${c.name}"  kind=${JSON.stringify(kind)}  refs=${JSON.stringify(references)}`);
      console.log(`    → ${cls.strategy} / ${cls.geminiTarget} / automatable=${cls.automatable}`);
      console.log('    RAW data:\n' + data.split('\n').map((l) => '      ' + l).join('\n').slice(0, 1500));
    }

    process.exit(0);
  }
  throw new Error(`agent matching "${NAME_MATCH}" not found in any environment`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
