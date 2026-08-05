// Clean sanity check for the 2026-08-04 ADK knowledge-parity fix, using an
// UPLOADED FILE instead of the SharePoint connector — isolates "does the fix
// work" from "is that federated SharePoint fixture set up right" (see
// .claude/memory/decisions.md and the conversation this script came from).
// Uses the already-proven, already-wired file-grounding path
// (migrateFileToDocumentStore) that adkDeployer.ts's publishAgentToGallery
// already calls for real FileUpload knowledge sources — no new mechanism,
// just a controlled, known-content test of the exact fixed code path.
//   npx tsx src/spikes/_diag_verify_adk_file_grounding_sanity.ts
import 'dotenv/config';
import { migrateFileToDocumentStore } from '../services/knowledgeDataStoreExecutor.js';
import { getSaToken } from '../auth/google.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import type { AgentIR, GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const AGENT_SOURCE_ID = 'adk-file-grounding-sanity-check';
const SECRET_MARKER = 'ZX-CONFLICT-7742';
const FILE_CONTENT =
  `SECRET TEST MARKER: ${SECRET_MARKER}\n\n` +
  'The onetime migration Conflict Report can be generated with this exact MongoDB query:\n' +
  "db.migrationConflicts.find({ status: 'conflict', runType: 'onetime' })\n";

async function main() {
  const saToken = await getSaToken();

  console.log('1) Uploading a small known-content test file into a document data store...');
  const ground = await migrateFileToDocumentStore(DEST.project, saToken, AGENT_SOURCE_ID, {
    name: 'sanity-check-facts.txt',
    bytes: Buffer.from(FILE_CONTENT, 'utf-8'),
    mimeType: 'text/plain',
  });
  console.log('   ->', JSON.stringify(ground, null, 2));
  if (!ground.resourcePath) {
    console.log('FAILED to ground the file — stopping.');
    return;
  }

  console.log('2) Deploying a fresh ADK agent via the FIXED publishAgentToGallery, grounded on that file...');
  const ir = {
    name: 'ADK-File-Grounding-Sanity-Check',
    description: 'Diagnostic — clean sanity check for the ADK knowledge-parity fix using a known-content uploaded file. Safe to delete.',
    instructions:
      'You are a diagnostic test assistant. Answer every question using whatever knowledge sources are ' +
      'available to you. If you use a knowledge source, quote the exact relevant text. If you cannot find ' +
      'relevant information anywhere, say so plainly instead of guessing.',
    capabilities: {},
  } as unknown as AgentIR;

  const adk = await publishAgentToGallery(DEST, saToken, ir, { groundingDataStores: [ground.resourcePath] });
  console.log('   ->', JSON.stringify(adk, null, 2));
  if (!adk.ok || !adk.reasoningEngine) {
    console.log('DEPLOY FAILED — stopping.');
    return;
  }

  console.log('3) Waiting 5s for registration to settle, then asking it the real content question...');
  await new Promise((r) => setTimeout(r, 5000));

  const ask = async (message: string) => {
    const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${adk.reasoningEngine}:streamQuery?alt=sse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'async_stream_query', input: { user_id: 'file-grounding-sanity', message } }),
    });
    console.log(`\n>>> ${message}`);
    console.log('status:', res.status);
    console.log(await res.text());
  };

  await ask('What secret test marker is mentioned in your knowledge source? Quote it exactly.');
  await ask('What MongoDB query do I use to get the Conflict report for a onetime migration? Quote it exactly.');
  await ask('What is the capital of France?'); // control — should NOT need the file

  console.log('\n--- SUMMARY ---');
  console.log(`New agent id: ${adk.agentId}`);
  console.log(`New reasoning engine: ${adk.reasoningEngine}`);
  console.log(`If the first two answers above actually contain "${SECRET_MARKER}" and the real MongoDB`);
  console.log('query text, the ADK grounding fix works end to end, cleanly, independent of the SharePoint fixture.');
}
main().catch((e) => console.error('FATAL:', e.message));
