import 'dotenv/config';
import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';
import { getSaToken } from '../auth/google.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { dataStoreExists, verifyDocumentsIndexed } from '../services/geminiDataStore.js';

const APP_USER_ID = 'default';
const ENV_URL = 'https://orga243378d.crm.dynamics.com';
const SOURCE_ID = 'ee2ea155-208c-f111-ab0f-0022480a981d';
const PROJECT = '231705905417';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const saToken = await getSaToken();

  const cached = await getCachedIR(APP_USER_ID, ENV_URL, SOURCE_ID);
  if (!cached) throw new Error('no cached IR found');
  console.log('knowledgeSources:', JSON.stringify(cached.ir.knowledgeSources.map((k) => ({ name: k.name, kind: k.kind, reference: k.reference, references: k.references })), null, 2));

  const knowledgeStoreRow = await db.collection('adkKnowledgeStores').findOne({ sourceId: SOURCE_ID });
  console.log('adkKnowledgeStores cached row:', JSON.stringify(knowledgeStoreRow, null, 2));
  if (knowledgeStoreRow) {
    const exists = await dataStoreExists(PROJECT, saToken, knowledgeStoreRow.dataStoreId);
    console.log('cached PRD dataStoreId still exists:', exists);
  }

  // Find any retry-suffixed live stores for this source in Console.
  const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
  const res = await fetch(`${HOST}/projects/${PROJECT}/locations/global/collections/default_collection/dataStores`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const j = (await res.json()) as { dataStores?: { name: string; displayName?: string }[] };
  const matches = (j.dataStores ?? []).filter((d) => d.name.includes(SOURCE_ID));
  console.log('all live data stores for this sourceId:', JSON.stringify(matches, null, 2));
  for (const m of matches) {
    const id = m.name.split('/').pop()!;
    const indexed = await verifyDocumentsIndexed(PROJECT, saToken, id);
    console.log(`  -> ${id}: indexed = ${indexed}`);
  }

  const connectors = await db.collection('knowledgeConnectors').find({ kind: 'sharepoint' }).toArray();
  console.log('all sharepoint connectors:', JSON.stringify(connectors, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
