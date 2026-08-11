import 'dotenv/config';
import { deployReasoningEngine } from '../services/adkDeployer.js';

const PROJECT = '231705905417';
const LOCATION = 'us-central1';

async function main() {
  const spec = {
    name: 'kb_grounding_test_agent_v2',
    displayName: 'KB-Grounding-Test-Agent-v2',
    description: 'Diagnostic test agent used to verify that knowledge sources (SharePoint and locally uploaded files) are actually fetched and grounded correctly after migration to Gemini Enterprise. Safe to delete after testing.',
    model: 'gemini-2.5-flash',
    instruction:
      'You are a diagnostic test assistant. Your ONLY job is to answer using the knowledge sources and files attached to you. You have NO other knowledge.\n\n' +
      'Rules:\n' +
      '- Before answering, check ONLY the attached knowledge sources and files. Do not use any general knowledge, pretraining, or web search, even if you know the answer.\n' +
      '- If the attached sources contain relevant information, answer using it and state clearly which source (file name) you used.\n' +
      '- If the attached sources do NOT contain relevant information, respond exactly: "I don\'t have that information in my attached knowledge sources." Do not guess, do not fill in from general knowledge, and do not apologize further.\n' +
      '- Never say a request is "out of scope" — either answer from the sources or give the exact fallback line above.\n' +
      '- Do not roleplay as a customer or any persona.',
    tools: [],
    groundingDataStores: [
      'projects/231705905417/locations/global/collections/default_collection/dataStores/124794af-3b8f-f111-b8da-0022480b1f83-file-slack-to-teams-migrat',
      'projects/231705905417/locations/global/collections/default_collection/dataStores/124794af-3b8f-f111-b8da-0022480b1f83-file-daily-queries-txt',
    ],
  };
  console.log('deploying (2-5 min)...');
  const result = await deployReasoningEngine(PROJECT, LOCATION, spec);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
