/**
 * Verify the CONTENT of a migrated knowledge file: reads the source Bot File
 * Attachment bytes from Dataverse (exactly what we upload to Gemini) and prints
 * size, SHA-256, and a text preview — so you can confirm it's complete/intact.
 *
 *   npx tsx src/_diag_file_content.ts ["agent name substring"] [previewChars]
 *
 * READ-ONLY. We upload these exact bytes to the agent, so what you see here is
 * what the agent received (Gemini doesn't expose stored content for re-download).
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { clientCredsToken } from './auth/microsoft.js';
import { fetchFileAttachmentBytes } from './services/dataverse.js';

const NAME_MATCH = (process.argv[2] || 'service operations').toLowerCase();
const PREVIEW = Number(process.argv[3] || 1200);

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

function isMostlyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4000);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
  }
  return n === 0 || printable / n > 0.85;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session — connect first');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots;
    try { bots = await dvGet(env.url, token, `bots?$select=name,botid&$filter=statecode eq 0`); } catch { continue; }
    // Check EVERY bot whose name matches (names collide, e.g. "Service Operations
    // Agent" vs "Customer Service Operations Agent") — don't just take the first.
    const matches = bots.value.filter((b) => String(b.name ?? '').toLowerCase().includes(NAME_MATCH));
    if (!matches.length) continue;
    console.log(`Matched ${matches.length} bot(s): ${matches.map((b) => `"${b.name}"`).join(', ')}`);

    let found = false;
    for (const bot of matches) {
      const comps = (await dvGet(
        env.url, token,
        `botcomponents?$select=name,filedata_name,componenttype&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid} and componenttype eq 14`,
      )).value;
      console.log(`\n=== ${bot.name} — ${comps.length} uploaded file(s) (type 14) ===`);
      for (const c of comps) {
        found = true;
        const fileName = (c.filedata_name as string) || (c.name as string) || 'file';
        const got = await fetchFileAttachmentBytes(env.url, token, c.botcomponentid as string);
        console.log(`\n  ── ${fileName} ──`);
        if (!got) { console.log('     (could not download bytes)'); continue; }
        const sha = createHash('sha256').update(got.bytes).digest('hex');
        console.log(`     size:      ${got.bytes.length} bytes`);
        console.log(`     sha256:    ${sha}`);
        console.log(`     source-ct: ${got.contentType}`);
        if (isMostlyText(got.bytes)) {
          const text = got.bytes.toString('utf8');
          console.log(`     preview (first ${PREVIEW} of ${text.length} chars):\n`);
          console.log(text.slice(0, PREVIEW).split('\n').map((l) => '       | ' + l).join('\n'));
          if (text.length > PREVIEW) console.log(`       … (${text.length - PREVIEW} more chars)`);
        } else {
          console.log('     (binary file — not previewing as text)');
        }
      }
    }
    if (!found) console.log('\n(no file attachments on any matched bot)');
    process.exit(0);
  }
  throw new Error(`agent matching "${NAME_MATCH}" not found`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
