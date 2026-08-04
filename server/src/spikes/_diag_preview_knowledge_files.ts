/**
 * Best-effort READ-ONLY text preview of an agent's uploaded file knowledge
 * sources (xlsx / pdf), so we can write test-chat questions that target real
 * content instead of guessing. Downloads the exact bytes we'd upload to
 * Gemini (fetchFileAttachmentBytes) — never writes to Dataverse or Gemini.
 *
 *   npx tsx src/spikes/_diag_preview_knowledge_files.ts ["agent name substring"]
 *
 * xlsx: unzips xl/sharedStrings.xml (no new dependency — uses the `unzip` CLI)
 *       and prints the distinct cell strings.
 * pdf:  best-effort — inflates FlateDecode streams and pulls text shown in
 *       Tj/TJ operators. Simple PDFs only; complex layouts may show little.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { fetchFileAttachmentBytes } from '../services/dataverse.js';

const NAME_MATCH = (process.argv[2] || 'CS_GE Knowledge Test Agent').toLowerCase();

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

function previewXlsx(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'csge-xlsx-'));
  const path = join(dir, 'wb.xlsx');
  writeFileSync(path, bytes);
  try {
    const xml = execFileSync('unzip', ['-p', path, 'xl/sharedStrings.xml'], { encoding: 'utf8' });
    const strings = [...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => m[1]).filter((s) => s.trim());
    return strings.length ? strings.join(' | ') : '(sharedStrings.xml empty or all-numeric cells)';
  } catch (e) {
    return `(could not read sharedStrings.xml: ${(e as Error).message})`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function previewPdf(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const texts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    const chunk = Buffer.from(m[1], 'latin1');
    let content: Buffer;
    try {
      content = inflateSync(chunk);
    } catch {
      continue; // not FlateDecode (image stream, already-inflated, etc.) — skip
    }
    const asText = content.toString('latin1');
    for (const tm of asText.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) texts.push(tm[1]);
    for (const tm of asText.matchAll(/\[((?:[^[\]]|\\.)*)\]\s*TJ/g)) {
      const inner = [...tm[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => x[1]);
      texts.push(inner.join(''));
    }
  }
  const cleaned = texts
    .map((t) => t.replace(/\\([()\\])/g, '$1'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '(no extractable text — likely scanned/image PDF or unsupported encoding)';
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session — connect via the web app first');

  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots;
    try { bots = await dvGet(env.url, token, `bots?$select=name,botid&$filter=statecode eq 0`); } catch { continue; }
    const matches = bots.value.filter((b) => String(b.name ?? '').toLowerCase().includes(NAME_MATCH));
    if (!matches.length) continue;

    for (const bot of matches) {
      const comps = (await dvGet(
        env.url, token,
        `botcomponents?$select=name,filedata_name,componenttype&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid} and componenttype eq 14`,
      )).value;
      console.log(`\n=== ${bot.name} — ${comps.length} uploaded file(s) ===`);
      for (const c of comps) {
        const fileName = (c.filedata_name as string) || (c.name as string) || 'file';
        const got = await fetchFileAttachmentBytes(env.url, token, c.botcomponentid as string);
        console.log(`\n  ── ${fileName} (${got?.bytes.length ?? 0} bytes) ──`);
        if (!got) { console.log('     (could not download)'); continue; }
        const ext = fileName.split('.').pop()?.toLowerCase();
        if (ext === 'xlsx') {
          console.log('  preview:', previewXlsx(got.bytes).slice(0, 2000));
        } else if (ext === 'pdf') {
          console.log('  preview:', previewPdf(got.bytes).slice(0, 2000));
        } else {
          console.log('  (unhandled extension for preview)');
        }
      }
    }
    process.exit(0);
  }
  throw new Error(`agent matching "${NAME_MATCH}" not found`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
