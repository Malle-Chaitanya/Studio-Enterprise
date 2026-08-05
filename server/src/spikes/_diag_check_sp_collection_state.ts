// Reads the SharePoint connector's Collection resource directly to see its
// real lifecycle state (dataConnector.realtimeState) and full raw shape —
// this tells apart "Google reports a real connector error" from "connector
// says ACTIVE but federated queries still return nothing because the
// Cloud-Console-only authorization step was never completed" (see
// geminiConnector.ts's own doc comment on getConnectorOperation).
//   npx tsx src/spikes/_diag_check_sp_collection_state.ts
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';

async function main() {
  const client = new MongoClient(process.env.MONGO_HOST || 'mongodb://localhost:27019');
  await client.connect();
  const db = client.db(process.env.CSGE_DB || 'csge');
  const conn = await db.collection('knowledgeConnectors').findOne({ kind: 'sharepoint' });
  console.log('knowledgeConnectors record:', JSON.stringify(conn, null, 2));
  await client.close();
  if (!conn?.collectionId) {
    console.log('No collectionId on record — cannot look up the Collection resource.');
    return;
  }

  const saToken = await getSaToken();
  const res = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${conn.collectionId}`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('\nCollection GET status:', res.status);
  console.log(JSON.stringify(await res.json(), null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
