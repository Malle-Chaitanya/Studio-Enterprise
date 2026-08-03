/**
 * Live (write) debug: re-run just the uploadAgentFile() call for
 * "system prompt.txt" against the already-created Gemini agent, printing the
 * FULL raw response instead of the silently-swallowed error that
 * attachKnowledgeFiles/orchestrator.ts currently produces on failure. Isolates
 * whether this is a Gemini-side rejection or a response-shape mismatch our
 * code misreads as failure.
 *
 *   npx tsx src/spikes/_diag_upload_txt_debug.ts [sessionId]
 *
 * WRITES to the real Gemini agent found from the most recent migration result
 * for "CS_GE Knowledge Test Agent" — attempts to attach one file. Low blast
 * radius (a disposable test agent), but not read-only like the other diags.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { getSaToken } from '../auth/google.js';
import { fetchFileAttachmentBytes } from '../services/dataverse.js';
import { uploadAgentFile, mimeTypeForFile, getAgent, readAgentFiles } from '../services/geminiAgentFiles.js';
import { defaultDestination } from '../services/gemini.js';
import type { MigrationResult } from '../types.js';

const SESSION_ID = process.argv[2];

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

async function main() {
  await connectMongo();
  const db = getDb(config.CSGE_DB);

  const result = (await db
    .collection<MigrationResult & { runId?: string }>('migrationResults')
    .find({ name: /CS_GE Knowledge Test Agent/i })
    .sort({ $natural: -1 })
    .limit(1)
    .next());
  if (!result?.geminiAgentId) throw new Error('no migration result with a geminiAgentId found for this agent — run the migration first');
  console.log('Found geminiAgentId:', result.geminiAgentId);

  const coll = db.collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');
  if (!s.geminiProject) throw new Error('session has no geminiProject');

  // Find the file's Dataverse bytes.
  let fileBytes: { bytes: Buffer; contentType: string } | null = null;
  let dvToken = '';
  let matchedEnvUrl = '';
  for (const env of s.environments ?? []) {
    try {
      dvToken = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch {
      continue;
    }
    let comps;
    try {
      comps = (await dvGet(
        env.url,
        dvToken,
        `botcomponents?$select=botcomponentid,filedata_name&$filter=statecode eq 0 and componenttype eq 14&$top=200`,
      )).value;
    } catch {
      continue;
    }
    const match = comps.find((c) => String(c.filedata_name ?? '').toLowerCase().includes('system'));
    if (match) {
      matchedEnvUrl = env.url;
      fileBytes = await fetchFileAttachmentBytes(env.url, dvToken, String(match.botcomponentid));
      break;
    }
  }
  if (!fileBytes) throw new Error('could not fetch system prompt.txt bytes');
  console.log(`Fetched ${fileBytes.bytes.length} bytes, contentType=${fileBytes.contentType}`);

  // Resolve the same GeminiDestination the orchestrator would have used for
  // this environment (mapped destination, falling back to the project's
  // default engine — mirrors orchestrator.ts's targetFor()).
  const envMap = s.plan?.destination.environmentMap ?? {};
  const dest = envMap[matchedEnvUrl] ?? defaultDestination(s.geminiProject);
  console.log('Destination:', dest);

  const saToken = await getSaToken(s.gEmail);

  // Check current agentFiles before, so we know if it's already there.
  const before = readAgentFiles(await getAgent(dest, saToken, result.geminiAgentId));
  console.log('agentFiles BEFORE:', before.map((f) => f.fileName));

  const mimeType = mimeTypeForFile('system prompt.txt', fileBytes.contentType);
  console.log('Resolved mimeType:', mimeType);

  const up = await uploadAgentFile(dest, saToken, result.geminiAgentId, {
    fileName: 'system prompt.txt',
    mimeType,
    bytes: fileBytes.bytes,
  });
  console.log('uploadAgentFile result:', JSON.stringify(up, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
