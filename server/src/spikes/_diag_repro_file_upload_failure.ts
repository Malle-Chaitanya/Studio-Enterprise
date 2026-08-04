/**
 * Reproduce the exact knowledge-file-attach steps for "CloudFuze Studio
 * Migrate" with FULL error visibility — the production code in
 * orchestrator.ts::attachKnowledgeFiles only counts failures ({ uploaded, failed,
 * skipped }), it discards the actual error string from uploadAgentFile/
 * updateAgentFiles and never fetches bytes with diagnostics. This script calls
 * the same functions directly and prints every error in full.
 *
 *   npx tsx src/spikes/_diag_repro_file_upload_failure.ts
 *
 * Writes to Gemini (creates a real file resource) ONLY if the fetch+upload
 * steps succeed — safe to run against the already-migrated agent since
 * attachKnowledgeFiles-style idempotency (skip existing by filename) is
 * replicated here too.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent, fetchFileAttachmentBytes } from '../services/dataverse.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { uploadAgentFile, mimeTypeForFile, getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  console.log(`session: tenant=${s.orgName ?? s.tenantId}  gEmail=${s.gEmail}  project=${s.geminiProject}`);

  const env = (s.environments ?? []).find((e) => e.name.toLowerCase().includes('default'));
  if (!env) throw new Error('no default environment');
  const dvToken = await clientCredsToken(s.tenantId ?? '', env.url);
  const bots = await listBots(env.url, dvToken);
  const bot = bots.find((b) => b.name.toLowerCase().includes('cloudfuze studio migrate'));
  if (!bot) throw new Error('bot not found');

  const ir = await extractAgent(env.url, dvToken, bot);
  const fileSources = ir.knowledgeSources.filter((k) => k.kind === 'FileUpload' && k.file?.name);
  console.log(`\nfile knowledge source(s): ${fileSources.length}`);
  for (const f of fileSources) {
    console.log(`  - id=${f.id}  name=${f.file?.name}  format=${f.file?.format}  compatible=${f.file?.compatible}  incompatReason=${f.file?.incompatReason ?? '(none)'}`);
  }
  if (!fileSources.length) throw new Error('no file knowledge sources on this agent');

  console.log('\n--- STEP 1: fetch bytes from Dataverse (fetchFileAttachmentBytes) ---');
  for (const f of fileSources) {
    const got = await fetchFileAttachmentBytes(env.url, dvToken, f.id);
    if (!got) {
      console.log(`  ✗ "${f.file?.name}" — fetchFileAttachmentBytes returned null (download failed — see WARN logs above for the real HTTP status)`);
      continue;
    }
    console.log(`  ✓ "${f.file?.name}" — ${got.bytes.length} bytes, contentType=${got.contentType}`);
  }

  console.log('\n--- STEP 2: find the created Gemini agent ---');
  const project = s.geminiProject ?? '';
  const dest = defaultDestination(project);
  const saToken = await getSaToken(s.gEmail || undefined);
  const agentsRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  if (!agentsRes.ok) throw new Error(`list agents failed (${agentsRes.status}): ${(await agentsRes.text()).slice(0, 300)}`);
  const agentsJson = (await agentsRes.json()) as { agents?: { name?: string; displayName?: string }[] };
  const match = (agentsJson.agents ?? []).find((a) => (a.displayName ?? '').toLowerCase().includes('cloudfuze studio migrate'));
  if (!match?.name) throw new Error('created agent not found in engine — was create actually successful?');
  const agentId = match.name.split('/').pop()!;
  console.log(`  ✓ found agent "${match.displayName}"  agentId=${agentId}`);

  const existing = readAgentFiles(await getAgent(dest, saToken, agentId));
  console.log(`  current agentFiles on this agent: ${existing.length ? existing.map((f) => f.fileName).join(', ') : '(none)'}`);

  console.log('\n--- STEP 3: upload each file (uploadAgentFile) — FULL error, not just pass/fail ---');
  for (const f of fileSources) {
    if (existing.some((e) => e.fileName === f.file?.name)) {
      console.log(`  · "${f.file?.name}" — already attached, skipping re-upload`);
      continue;
    }
    const got = await fetchFileAttachmentBytes(env.url, dvToken, f.id);
    if (!got) { console.log(`  ✗ "${f.file?.name}" — can't upload, byte fetch failed (see Step 1)`); continue; }
    const mime = mimeTypeForFile(f.file!.name!, got.contentType);
    console.log(`  uploading "${f.file?.name}" as ${mime} (${got.bytes.length} bytes)...`);
    const up = await uploadAgentFile(dest, saToken, agentId, { fileName: f.file!.name!, mimeType: mime, bytes: got.bytes });
    if (up.ok) {
      console.log(`  ✓ upload succeeded — raw response:`, JSON.stringify(up.raw, null, 2).slice(0, 1000));
    } else {
      console.log(`  ✗ UPLOAD FAILED — this is the real reason, hidden by the production code:\n    ${up.error}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
