// Creates a REAL low-code test agent on the C2 engine to verify knowledge-source
// grounding end to end: SharePoint connector data store + a locally uploaded
// file + plain instructions/description (no refusal persona, so it will
// actually attempt to answer instead of blocking every off-script question).
//   npx tsx src/spikes/_diag_create_kb_test_agent.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { createAgent, publishAgent, shareAgent } from '../services/gemini.js';
import { attachDataStoreToEngine } from '../services/geminiDataStore.js';
import { uploadAgentFile, updateAgentFiles } from '../services/geminiAgentFiles.js';
import type { GeminiDestination, MappedAgent, AgentIR } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const SHAREPOINT_DATA_STORE_ID = 'filefuze-sp-d4a33c3a8821_file'; // daily_queries.txt connector, already provisioned

async function main() {
  const saToken = await getSaToken();

  console.log('1) Attaching SharePoint data store to the engine (idempotent)...');
  const attach = await attachDataStoreToEngine(DEST, saToken, SHAREPOINT_DATA_STORE_ID);
  console.log('   ->', JSON.stringify(attach));

  console.log('2) Creating test agent...');
  const mapped: MappedAgent = {
    ir: {} as AgentIR, // unused by createAgent's request body
    displayName: 'KB-Grounding-Test-Agent',
    description:
      'Diagnostic test agent — verifies SharePoint knowledge-source grounding and locally uploaded file grounding for CS_GE. Safe to delete.',
    instruction:
      'You are a diagnostic test assistant. Answer every question directly and helpfully using ' +
      'whatever knowledge sources or uploaded files are available to you. Never refuse a question ' +
      'as "out of scope." If you use information from an uploaded file or a knowledge source, say ' +
      'explicitly which one you used. If you cannot find relevant information anywhere, say so plainly ' +
      'instead of guessing.',
    starterPrompts: [
      { text: 'What MongoDB query do I use to get the Conflict report for a onetime migration?' },
      { text: "What is the secret test marker in the uploaded file?" },
    ],
    model: 'gemini-2.5-flash',
    tools: [{ name: 'googleSearch' }],
    fidelityNotes: [],
  };
  const outcome = await createAgent(DEST, saToken, mapped);
  console.log('   ->', JSON.stringify(outcome));
  if (!outcome.created || !outcome.agentId) {
    console.log('FAILED to create agent, stopping.');
    process.exit(1);
  }
  const agentId = outcome.agentId;

  console.log('3) Uploading a local test file with a distinguishing marker...');
  const marker = 'PINEAPPLE-7042';
  const fileBytes = Buffer.from(
    `Local upload grounding test file.\nSECRET TEST MARKER: ${marker}\n` +
    `This value only exists in this locally uploaded file, not in any SharePoint source or the model's own knowledge.\n`,
    'utf8',
  );
  const upload = await uploadAgentFile(DEST, saToken, agentId, {
    fileName: 'local-grounding-test.txt',
    mimeType: 'text/plain',
    bytes: fileBytes,
  });
  console.log('   upload ->', JSON.stringify(upload).slice(0, 300));

  const raw = upload.raw as { name?: string; fileName?: string; mimeType?: string } | undefined;
  if (upload.ok && raw?.name) {
    const attachFile = await updateAgentFiles(DEST, saToken, agentId, [
      { name: raw.name, fileName: raw.fileName ?? 'local-grounding-test.txt', mimeType: raw.mimeType ?? 'text/plain' },
    ]);
    console.log('   attach file to agent ->', JSON.stringify(attachFile));
  } else {
    console.log('   ⚠️ upload did not return a usable file resource name — file NOT attached. Raw:', JSON.stringify(upload));
  }

  console.log('4) Publishing...');
  console.log('   publish ->', await publishAgent(DEST, saToken, agentId));

  console.log('5) Sharing (ALL_USERS)...');
  console.log('   share ->', await shareAgent(DEST, saToken, agentId));

  console.log('\n✅ Done.');
  console.log(`Agent ID: ${agentId}`);
  console.log(`Resource: projects/${DEST.project}/locations/global/collections/default_collection/engines/${DEST.engine}/assistants/${DEST.assistant}/agents/${agentId}`);
  console.log(`Secret marker to test uploaded-file grounding: "${marker}" (ask: "What is the secret test marker in the uploaded file?")`);
  console.log(`SharePoint test question: "What MongoDB query do I use to get the Conflict report for a onetime migration?"`);
  console.log('Find it in the Gemini Enterprise UI under Agents, search for "KB-Grounding-Test-Agent".');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
