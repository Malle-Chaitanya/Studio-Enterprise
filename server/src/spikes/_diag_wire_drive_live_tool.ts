/**
 * Option A: wire Agent1 to a LIVE Google Drive function tool (real Drive API
 * calls, our own SA impersonating Erik) instead of the native Discovery Engine
 * Workspace data store, which 403s for headless/service-account callers.
 *
 * Steps: store the SA key + impersonate_email as connector secrets (same
 * naming this app's real UI flow would use), build the live connector spec,
 * redeploy Agent1 with liveConnectors instead of groundingDataStores.
 */
import 'dotenv/config';
import { config } from '../config.js';
import { readFileSync } from 'node:fs';
import { getSaToken } from '../auth/google.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { buildLiveConnectorSpecs } from '../services/connectorToolBuilder.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import type { AgentIR, GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};
const EXISTING_AGENT_ID = '14212399438010454597';
const CONNECTOR_ID = 'shared_googledrive';
const IMPERSONATE = 'erik@filefuze.co';

function loadOwnSaKeyJson(): string {
  if (config.GOOGLE_SA_KEY_JSON) return config.GOOGLE_SA_KEY_JSON;
  if (config.GOOGLE_SA_KEY_FILE) return readFileSync(config.GOOGLE_SA_KEY_FILE, 'utf8');
  throw new Error('no SA key configured (GOOGLE_SA_KEY_JSON/GOOGLE_SA_KEY_FILE)');
}

const ir: AgentIR = {
  sourceId: 'agent1-drive-sanity-check',
  name: 'Agent1',
  description: 'Test agent covering all knowledge source types for migration validation',
  instructions:
    'You are a diagnostic test assistant. Your ONLY job is to answer using the tools attached to you. You have NO other knowledge.\n\n' +
    'Rules:\n' +
    '- When asked about Google Drive files or folders, use the Google Drive tool. Do not use any general knowledge, pretraining, or web search, even if you know the answer.\n' +
    '- If the tool returns relevant information, answer using it and state clearly it came from Google Drive.\n' +
    '- If the tool returns no relevant information or errors, say so plainly: state the error if there is one. Do not guess, do not invent file names.\n' +
    '- NEVER call a create tool to fulfil a copy, update, or delete request. If the user refers to an existing file or folder by name (e.g. "that file", "the VAS.csv I just made"), first resolve it — reuse its ID from earlier in this conversation if you have it, or call google_drive_find_by_path to look it up by name/path. Only call a create tool when the user is explicitly asking for something new to be made. Creating a duplicate instead of finding the original is a real error, not a safe default.\n' +
    '- If you do not already know the FULL path to something the user named (e.g. "the CCB folder" without knowing what it is nested inside), do not guess a path for google_drive_find_by_path — call google_drive_search_by_name instead, which searches everywhere. If that returns more than one match, do not pick one yourself — tell the user there are multiple matches and ask which one, or use google_drive_list_files on their parent folders to tell them apart. Never act on an ambiguous match.\n' +
    '- Stay focused on the user\'s CURRENT request only. Do not continue or resume an earlier, unrelated action from earlier in this conversation unless the user explicitly asks you to.',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [],
  topics: [],
  knowledgeSources: [],
  unmapped: [],
};

async function main() {
  const saToken = await getSaToken();
  const project = DEST.project;

  console.log('storing connector secrets...');
  await upsertSecret(saToken, project, connectorSecretId(CONNECTOR_ID, 'service_account_json'), loadOwnSaKeyJson());
  await upsertSecret(saToken, project, connectorSecretId(CONNECTOR_ID, 'impersonate_email'), IMPERSONATE);
  console.log('secrets stored.');

  const liveConnectors = buildLiveConnectorSpecs([CONNECTOR_ID]);
  console.log('liveConnectors spec:', JSON.stringify(liveConnectors, null, 2));

  console.log('redeploying Agent1 with the live Drive tool (2-5 min)...');
  const result = await publishAgentToGallery(DEST, saToken, ir, {
    liveConnectors,
    existingAgentId: EXISTING_AGENT_ID,
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
