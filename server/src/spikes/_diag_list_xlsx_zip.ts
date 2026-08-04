/** One-off: list the internal zip structure of the test agent's xlsx so we
 * know which XML holds cell text (some workbooks use inline strings, not a
 * sharedStrings.xml table). Read-only. */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { fetchFileAttachmentBytes } from '../services/dataverse.js';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots: Record<string, unknown>[];
    try { bots = (await dvGet(env.url, token, `bots?$select=name,botid&$filter=statecode eq 0`)).value ?? []; } catch { continue; }
    const bot = bots.find((b) => String(b.name ?? '').toLowerCase().includes('cs_ge knowledge test agent'));
    if (!bot) continue;
    const comps = (await dvGet(env.url, token, `botcomponents?$select=name,filedata_name,componenttype&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid} and componenttype eq 14`)).value;
    const c = comps.find((x) => String(x.filedata_name ?? '').toLowerCase().endsWith('.xlsx'));
    if (!c) throw new Error('no xlsx found');
    const got = await fetchFileAttachmentBytes(env.url, token, c.botcomponentid as string);
    if (!got) throw new Error('download failed');
    const dir = mkdtempSync(join(tmpdir(), 'csge-xlsx-'));
    const p = join(dir, 'wb.xlsx');
    writeFileSync(p, got.bytes);
    const wb = execFileSync('unzip', ['-p', p, 'xl/workbook.xml'], { encoding: 'utf8' });
    const sheetNames = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]);
    console.log('sheets:', sheetNames.join(', '));
    for (let i = 1; i <= sheetNames.length; i++) {
      let xml: string;
      try { xml = execFileSync('unzip', ['-p', p, `xl/worksheets/sheet${i}.xml`], { encoding: 'utf8' }); } catch { continue; }
      const inline = [...xml.matchAll(/<is><t(?:\s[^>]*)?>([^<]*)<\/t><\/is>/g)].map((m) => m[1]);
      const cells = [...xml.matchAll(/<c [^>]*r="([A-Z]+\d+)"[^>]*>(?:<v>([^<]*)<\/v>)?/g)].slice(0, 40);
      console.log(`\n--- sheet${i} "${sheetNames[i - 1] ?? ''}" (${xml.length} bytes) ---`);
      console.log('inline strings:', inline.slice(0, 60).join(' | ') || '(none)');
      console.log('first cells (ref=value):', cells.map((c) => `${c[1]}=${c[2] ?? ''}`).join(' , '));
    }
    process.exit(0);
  }
  throw new Error('agent not found');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
