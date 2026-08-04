/**
 * Verify the agent-file UPLOAD call in isolation (the one API shape we couldn't
 * confirm from public docs). Uploads a tiny in-memory text file to an EXISTING
 * migrated agent, then GETs the agent to see whether it landed in agentFiles[].
 *
 *   npx tsx src/spikes/_diag_upload_file.ts "service operations"
 *
 * If it prints an uploaded file resource and/or the file shows up under
 * lowCodeAgentDefinition.agentFiles, the upload shape is correct and I can wire
 * the real Dataverse-file → agentFiles pipeline. If it 4xxs, the error tells us
 * exactly how to correct the request.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, defaultDestination } from '../services/gemini.js';
import { uploadAgentFile, getAgent, updateAgentFiles, readAgentFiles, type AgentFile } from '../services/geminiAgentFiles.js';

const NAME_MATCH = (process.argv[2] || '').toLowerCase();

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject — connect Google first');

  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(s.geminiProject);

  // Find the target agent id.
  const listRes = await fetch(`${assistantBase(dest)}/agents`, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!listRes.ok) throw new Error(`list agents failed (${listRes.status})`);
  const agents = ((await listRes.json()) as { agents?: Record<string, unknown>[] }).agents ?? [];
  const agent = agents.find((a) => String(a.displayName ?? '').toLowerCase().includes(NAME_MATCH)) ?? agents[0];
  if (!agent) throw new Error('no agent found');
  const agentId = String(agent.name).split('/').pop()!;
  console.log(`Target agent: ${agent.displayName} (${agentId})`);

  // Upload a tiny probe file.
  const bytes = Buffer.from('CloudFuze knowledge-migration upload probe.\n', 'utf8');
  console.log('\nUploading probe file (cf-upload-probe.txt)…');
  const up = await uploadAgentFile(dest, saToken, agentId, {
    fileName: 'cf-upload-probe.txt',
    mimeType: 'text/plain',
    bytes,
  });
  if (!up.ok) {
    console.log(`UPLOAD FAILED → ${up.error}`);
    process.exit(1);
  }
  const uploaded = (up.raw as { agentFile?: AgentFile }).agentFile;
  console.log('UPLOAD OK →', JSON.stringify(uploaded, null, 2));
  if (!uploaded?.name) throw new Error('upload returned no agentFile.name');

  // Attach: append the uploaded file to the agent's existing agentFiles, PATCH.
  const before = readAgentFiles(await getAgent(dest, saToken, agentId));
  console.log(`\nAttaching to agentFiles (had ${before.length})…`);
  const attach = await updateAgentFiles(dest, saToken, agentId, [...before, uploaded]);
  if (!attach.ok) {
    console.log(`ATTACH FAILED → ${attach.error}`);
    process.exit(1);
  }
  console.log('ATTACH OK');

  // Verify.
  const files = readAgentFiles(await getAgent(dest, saToken, agentId));
  const present = files.some((f) => f.name === uploaded.name);
  console.log(`\nagentFiles now on the agent (${files.length}) — probe present: ${present ? 'YES ✅' : 'NO ❌'}`);
  console.log(JSON.stringify(files, null, 2));

  process.exit(present ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
