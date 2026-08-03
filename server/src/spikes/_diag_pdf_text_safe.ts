/**
 * Safe (non-regex-backtracking) best-effort PDF text preview. The earlier
 * script (_diag_preview_knowledge_files.ts) uses a regex with nested
 * quantifiers for parenthesized PDF text — that can catastrophically
 * backtrack on certain byte patterns and hang; this does a linear
 * character-by-character scan instead, so it can't hang regardless of
 * content. Read-only — downloads the exact bytes we'd upload to Gemini.
 *
 *   npx tsx src/spikes/_diag_pdf_text_safe.ts ["agent name substring"]
 */
import 'dotenv/config';
import { inflateSync } from 'node:zlib';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { fetchFileAttachmentBytes } from '../services/dataverse.js';

const NAME_MATCH = (process.argv[2] || 'CloudFuze Studio Migrate').toLowerCase();

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

/** Linear scan: pull text out of `(...)Tj` / `[(...) (...) ...]TJ` operators
 *  without any backtracking-prone regex. Handles \(, \), \\ escapes. */
function extractParenTexts(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] !== '(') { i++; continue; }
    let j = i + 1;
    let buf = '';
    let depth = 1;
    while (j < n && depth > 0) {
      const c = s[j];
      if (c === '\\' && j + 1 < n) { buf += s[j + 1]; j += 2; continue; }
      if (c === '(') { depth++; buf += c; j++; continue; }
      if (c === ')') { depth--; j++; if (depth === 0) break; buf += c; continue; }
      buf += c;
      j++;
    }
    // Look ahead a few chars for Tj/TJ to only keep actual show-text operands.
    const lookahead = s.slice(j, j + 6);
    if (/^\s*Tj/.test(lookahead) || /^\s*\]\s*TJ/.test(lookahead) || /^\s*$/.test(lookahead) === false) {
      out.push(buf);
    }
    i = j;
  }
  return out;
}

function previewPdfSafe(bytes: Buffer, capStreams = 500): string {
  const raw = bytes.toString('latin1');
  const texts: string[] = [];
  let pos = 0;
  let streamsSeen = 0;
  while (streamsSeen < capStreams) {
    const startIdx = raw.indexOf('stream', pos);
    if (startIdx === -1) break;
    // Skip past the newline after 'stream'.
    let bodyStart = startIdx + 'stream'.length;
    if (raw[bodyStart] === '\r') bodyStart++;
    if (raw[bodyStart] === '\n') bodyStart++;
    const endIdx = raw.indexOf('endstream', bodyStart);
    if (endIdx === -1) break;
    streamsSeen++;
    const chunk = Buffer.from(raw.slice(bodyStart, endIdx), 'latin1');
    pos = endIdx + 'endstream'.length;
    let content: Buffer;
    try {
      content = inflateSync(chunk);
    } catch {
      continue;
    }
    const asText = content.toString('latin1');
    texts.push(...extractParenTexts(asText));
  }
  const cleaned = texts.join(' ').replace(/\s+/g, ' ').trim();
  return cleaned || `(no extractable text across ${streamsSeen} stream(s) — likely scanned/image PDF)`;
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
    const bot = bots.find((b) => String(b.name ?? '').toLowerCase().includes(NAME_MATCH));
    if (!bot) continue;

    const comps = (await dvGet(
      env.url, token,
      `botcomponents?$select=name,filedata_name,componenttype&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid} and componenttype eq 14`,
    )).value;
    console.log(`\n=== ${bot.name} — ${comps.length} uploaded file(s) ===`);
    for (const c of comps) {
      const fileName = (c.filedata_name as string) || (c.name as string) || 'file';
      if (!fileName.toLowerCase().endsWith('.pdf')) continue;
      const started = Date.now();
      const got = await fetchFileAttachmentBytes(env.url, token, c.botcomponentid as string);
      if (!got) { console.log(`  ✗ ${fileName}: could not download`); continue; }
      const preview = previewPdfSafe(got.bytes);
      console.log(`\n  ── ${fileName} (${got.bytes.length} bytes, extracted in ${Date.now() - started}ms) ──`);
      console.log(preview.slice(0, 4000));
      if (preview.length > 4000) console.log(`  … (${preview.length - 4000} more chars)`);
    }
    process.exit(0);
  }
  throw new Error(`agent matching "${NAME_MATCH}" not found`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
