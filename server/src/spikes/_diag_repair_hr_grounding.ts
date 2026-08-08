import 'dotenv/config';
import { connectDb } from '../db/core.js';
import { config } from '../config.js';
import { getSaToken } from '../auth/google.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { upsertAdkKnowledgeStore } from '../db/repos/adkKnowledgeStores.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { recordAdkDeployment, getAdkDeployment } from '../db/repos/adkDeployments.js';
import type { GeminiDestination } from '../types.js';

const APP_USER_ID = 'default';
const ENV_URL = 'https://orga243378d.crm.dynamics.com';
const SOURCE_ID = '48248234-cb90-f111-8077-0022480a981d';
const FILE_NAME = 'Neutara HR Leave Policies_2024.pdf';
const REAL_DATA_STORE_ID = '48248234-cb90-f111-8077-0022480a981d-file-neutara-hr--rmshbtmgd';
const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

async function main() {
  await connectDb(config.CSGE_DB);
  const saToken = await getSaToken();

  const resourcePath = `projects/${DEST.project}/locations/global/collections/default_collection/dataStores/${REAL_DATA_STORE_ID}`;

  await upsertAdkKnowledgeStore({
    appUserId: APP_USER_ID,
    sourceId: SOURCE_ID,
    fileName: FILE_NAME,
    dataStoreId: REAL_DATA_STORE_ID,
    resourcePath,
    status: 'done',
  });
  console.log('cache repaired ->', resourcePath);

  const cached = await getCachedIR(APP_USER_ID, ENV_URL, SOURCE_ID);
  if (!cached) throw new Error('no cached IR found for this agent — cannot rebuild spec');
  console.log('using cached IR, knowledgeSources:', cached.ir.knowledgeSources.map((k) => k.name));

  const existing = await getAdkDeployment(APP_USER_ID, ENV_URL, SOURCE_ID, DEST);
  if (!existing) throw new Error('no existing adkDeployment record found');
  console.log('existing agentId:', existing.agentId);

  const result = await publishAgentToGallery(DEST, saToken, cached.ir, {
    groundingDataStores: [{ resourcePath, sourceName: FILE_NAME }],
    existingAgentId: existing.agentId,
  });
  console.log('publishAgentToGallery result:', JSON.stringify(result, null, 2));

  if (result.ok) {
    await recordAdkDeployment(APP_USER_ID, ENV_URL, SOURCE_ID, DEST, {
      reasoningEngine: result.reasoningEngine!,
      agentId: result.agentId!,
    });
    console.log('adkDeployments record updated.');
  }
}
main().catch((e) => console.error('FAILED:', e.message));
