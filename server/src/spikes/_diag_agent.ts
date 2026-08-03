/**
 * Diagnostic: dump the RAW Dataverse data for one agent so we can see exactly
 * what the source contains vs. what our extractor keeps.
 *   npx tsx src/spikes/_diag_agent.ts <sessionId> "<agent name substring>"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const SESSION_ID = process.argv[2];
const NAME_MATCH = (process.argv[3] || '').toLowerCase();

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as never })) as Session | null;
  if (!s) throw new Error('session not found');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots;
    try {
      // Pull EVERY column on the bot so we can see description etc.
      bots = await dvGet(env.url, token, `bots?$filter=statecode eq 0`);
    } catch { continue; }
    const match = bots.value.find((b) => String(b.name ?? '').toLowerCase().includes(NAME_MATCH));
    if (!match) continue;

    console.log(`\n=== ENV: ${env.name} ===`);
    console.log(`\n--- BOT entity columns (non-null) ---`);
    const FULL = new Set(['configuration', 'synchronizationstatus']);
    for (const [k, v] of Object.entries(match)) {
      if (v === null || v === '' || k.startsWith('_') || k.startsWith('@')) continue;
      if (k === 'iconbase64') { console.log(`  iconbase64: <${String(v).length} chars>`); continue; }
      const str = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      if (FULL.has(k)) { console.log(`  ${k} (FULL):\n${str.split('\n').map((l) => '      ' + l).join('\n')}`); continue; }
      console.log(`  ${k}: ${str.length > 200 ? str.slice(0, 200) + `… (${str.length} chars)` : str}`);
    }
    console.log(`\n  description field present? ${'description' in match ? JSON.stringify(match.description) : 'NO SUCH COLUMN'}`);

    const botId = match.botid as string;
    const comps = await dvGet(
      env.url,
      token,
      `botcomponents?$select=name,componenttype,data&$filter=statecode eq 0 and _parentbotid_value eq ${botId}&$top=1000`,
    );
    console.log(`\n--- ${comps.value.length} botcomponents ---`);
    for (const c of comps.value) {
      const data = (c.data as string) ?? '';
      console.log(`\n  [type ${c.componenttype}] ${c.name}  (data: ${data.length} chars)`);
      if (Number(c.componenttype) === 15 || /gpt|metadata/i.test(String(c.name))) {
        console.log('  ── GptComponentMetadata RAW ──');
        console.log(data.split('\n').map((l) => '    ' + l).join('\n').slice(0, 3000));
      } else if (data.length < 500) {
        console.log('    ' + data.replace(/\n/g, '\n    '));
      } else {
        console.log('    ' + data.slice(0, 400).replace(/\n/g, '\n    ') + ' …');
      }
    }
    process.exit(0);
  }
  throw new Error(`agent matching "${NAME_MATCH}" not found`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
