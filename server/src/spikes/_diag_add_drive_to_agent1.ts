/**
 * Redeploy Agent1 (an existing throwaway knowledge-source test agent) with the
 * new Erik_googleDrive data store attached, repointing its existing agent id
 * at a freshly-deployed Reasoning Engine (same pattern as
 * _diag_repair_hr_grounding.ts). Any data stores Agent1 had before this run
 * are NOT preserved — deliberate, per the "just get Drive working" scope
 * agreed with the user.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import type { AgentIR, GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const EXISTING_AGENT_ID = '14212399438010454597';
const DRIVE_RESOURCE_PATH =
  'projects/231705905417/locations/global/collections/default_collection/dataStores/erik-googledrive_1786356561493_google_drive';

const ir: AgentIR = {
  sourceId: 'agent1-drive-sanity-check',
  name: 'Agent1',
  description: 'Test agent covering all knowledge source types for migration validation',
  instructions:
    'You are a diagnostic test assistant. Your ONLY job is to answer using the knowledge sources attached to you. You have NO other knowledge.\n\n' +
    'Rules:\n' +
    '- Before answering, check ONLY the attached knowledge sources. Do not use any general knowledge, pretraining, or web search, even if you know the answer.\n' +
    '- If the attached sources contain relevant information, answer using it and state clearly which source you used.\n' +
    '- If the attached sources do NOT contain relevant information, respond exactly: "I don\'t have that information in my attached knowledge sources." Do not guess.',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [],
  topics: [],
  knowledgeSources: [],
  unmapped: [],
};

async function main() {
  const saToken = await getSaToken();
  console.log('redeploying Agent1 with Erik_googleDrive attached (2-5 min)...');
  const result = await publishAgentToGallery(DEST, saToken, ir, {
    groundingDataStores: [{ resourcePath: DRIVE_RESOURCE_PATH, sourceName: 'Erik Google Drive' }],
    existingAgentId: EXISTING_AGENT_ID,
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
