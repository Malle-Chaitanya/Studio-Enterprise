import 'dotenv/config';
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';
import { getSaToken } from '../auth/google.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { upsertAdkKnowledgeStore } from '../db/repos/adkKnowledgeStores.js';
import { markKnowledgeConnectorStatus } from '../db/repos/knowledgeConnectors.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { recordAdkDeployment, getAdkDeployment } from '../db/repos/adkDeployments.js';
import type { GeminiDestination } from '../types.js';

const APP_USER_ID = 'default';
const ENV_URL = 'https://orga243378d.crm.dynamics.com';
const SOURCE_ID = 'ee2ea155-208c-f111-ab0f-0022480a981d';
const PRD_FILE_NAME = 'Migrate_Agent_PRD_Full (6).pdf';
const REAL_PRD_DATA_STORE_ID = 'ee2ea155-208c-f111-ab0f-0022480a981d-file-migrate-age-rmshc1i02';
const DEAD_SP_SITE_URL = 'https://filefuze.sharepoint.com';
const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

async function main() {
  await connectDb(config.CSGE_DB);
  await getDb(config.CSGE_DB); // ensure connected before repo calls
  const saToken = await getSaToken();

  const resourcePath = `projects/${DEST.project}/locations/global/collections/default_collection/dataStores/${REAL_PRD_DATA_STORE_ID}`;
  await upsertAdkKnowledgeStore({
    appUserId: APP_USER_ID,
    sourceId: SOURCE_ID,
    fileName: PRD_FILE_NAME,
    dataStoreId: REAL_PRD_DATA_STORE_ID,
    resourcePath,
    status: 'done',
  });
  console.log('PRD cache repaired ->', resourcePath);

  // The SharePoint connector's cached data store was deleted out-of-band and
  // has no live replacement (it's a whole-folder reference, so copy mode
  // never covered it — see orchestrator.ts). Clear the stale IDs so this
  // honestly reports as needing re-setup instead of silently referencing a
  // dead store again on a future run.
  await markKnowledgeConnectorStatus(APP_USER_ID, 'sharepoint', DEAD_SP_SITE_URL, { dataStoreIds: [] });
  console.log('cleared stale SharePoint connector cache for', DEAD_SP_SITE_URL);

  const cached = await getCachedIR(APP_USER_ID, ENV_URL, SOURCE_ID);
  if (!cached) throw new Error('no cached IR found for this agent — cannot rebuild spec');

  const existing = await getAdkDeployment(APP_USER_ID, ENV_URL, SOURCE_ID, DEST);
  if (!existing) throw new Error('no existing adkDeployment record found');
  console.log('existing agentId:', existing.agentId);

  // SharePoint source is excluded — honestly reported as lost, not crashed.
  const result = await publishAgentToGallery(DEST, saToken, cached.ir, {
    groundingDataStores: [{ resourcePath, sourceName: PRD_FILE_NAME }],
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
