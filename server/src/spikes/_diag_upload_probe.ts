/**
 * Probe several candidate agent-file upload shapes to find the one Discovery
 * Engine actually accepts (the previous attempt 404'd — wrong path/method).
 *
 *   npx tsx src/spikes/_diag_upload_probe.ts "service operations"
 *
 * Prints the HTTP status + short response for each candidate. We're looking for
 * the one that is NOT "404 Could not find handler" — a 200 (works) or even a
 * 400 (right endpoint, wrong body) tells us the correct method family.
 * READ-ONLY-ish: at most it uploads a tiny probe .txt if a candidate succeeds.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, defaultDestination } from '../services/gemini.js';
import { agentResourcePath } from '../services/geminiAgentFiles.js';

const NAME_MATCH = (process.argv[2] || '').toLowerCase();
const HOST = 'https://discoveryengine.googleapis.com';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);

  const listRes = await fetch(`${assistantBase(dest)}/agents`, { headers: { Authorization: `Bearer ${saToken}` } });
  const agents = ((await listRes.json()) as { agents?: Record<string, unknown>[] }).agents ?? [];
  const agent = agents.find((a) => String(a.displayName ?? '').toLowerCase().includes(NAME_MATCH)) ?? agents[0];
  const agentId = String(agent.name).split('/').pop()!;
  const parent = agentResourcePath(dest, agentId);
  console.log(`Target: ${agent.displayName} (${agentId})\n`);

  const bytes = Buffer.from('CloudFuze upload probe\n', 'utf8');
  const b64 = bytes.toString('base64');
  const auth = { Authorization: `Bearer ${saToken}` };
  const json = { ...auth, 'Content-Type': 'application/json' };

  const boundary = 'cfzeboundary';
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ fileName: 'cf-probe.txt', mimeType: 'text/plain' })}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n`, 'utf8'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const candidates: { label: string; url: string; init: RequestInit }[] = [
    { label: 'A media (raw) /upload …/files?uploadType=media',
      url: `${HOST}/upload/v1alpha/${parent}/files?uploadType=media`,
      init: { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain', 'X-Goog-Upload-File-Name': 'cf-probe.txt' }, body: bytes } },
    { label: 'B create JSON POST …/files {fileName,mimeType}',
      url: `${HOST}/v1alpha/${parent}/files`,
      init: { method: 'POST', headers: json, body: JSON.stringify({ fileName: 'cf-probe.txt', mimeType: 'text/plain' }) } },
    { label: 'C create JSON POST …/files {fileName,mimeType,content(b64)}',
      url: `${HOST}/v1alpha/${parent}/files`,
      init: { method: 'POST', headers: json, body: JSON.stringify({ fileName: 'cf-probe.txt', mimeType: 'text/plain', content: b64 }) } },
    { label: 'D custom …/files:upload {fileName,mimeType,content(b64)}',
      url: `${HOST}/v1alpha/${parent}/files:upload`,
      init: { method: 'POST', headers: json, body: JSON.stringify({ fileName: 'cf-probe.txt', mimeType: 'text/plain', content: b64 }) } },
    { label: 'E import …/files:import {inlineSource}',
      url: `${HOST}/v1alpha/${parent}/files:import`,
      init: { method: 'POST', headers: json, body: JSON.stringify({ inlineSource: { files: [{ fileName: 'cf-probe.txt', mimeType: 'text/plain', content: b64 }] } }) } },
    { label: 'F multipart /upload …/files?uploadType=multipart',
      url: `${HOST}/upload/v1alpha/${parent}/files?uploadType=multipart`,
      init: { method: 'POST', headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart } },
    { label: 'G resumable start /upload …/files?uploadType=resumable',
      url: `${HOST}/upload/v1alpha/${parent}/files?uploadType=resumable`,
      init: { method: 'POST', headers: { ...json, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start' }, body: JSON.stringify({ fileName: 'cf-probe.txt', mimeType: 'text/plain' }) } },
  ];

  for (const c of candidates) {
    try {
      const res = await fetch(c.url, c.init);
      const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
      const flag = res.status === 404 ? '' : res.ok ? '  ✅✅✅ WORKS' : '  ⭐ endpoint exists (body issue)';
      console.log(`[${c.label}]\n   ${res.status} ${text}${flag}\n`);
    } catch (e) {
      console.log(`[${c.label}]\n   THREW ${(e as Error).message}\n`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
