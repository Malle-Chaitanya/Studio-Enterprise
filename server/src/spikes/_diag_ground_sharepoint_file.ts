// Uploads the real SharePoint file into a Discovery Engine document store
// using the SAME proven mechanism as the working Slack-to-Teams PDF grounding
// — no connector, no OAuth, no federated/ingestion complexity at all.
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { migrateFileToDocumentStore } from '../services/knowledgeDataStoreExecutor.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from '../services/graphFiles.js';

const PROJECT = '231705905417';
const AGENT_SOURCE_ID = '124794af-3b8f-f111-b8da-0022480b1f83';
// Set these in server/.env (never hardcode/commit) — see .env.example.
const TENANT_ID = process.env.DIAG_MS_TENANT_ID!;
const CLIENT_ID = process.env.DIAG_MS_CLIENT_ID!;
const CLIENT_SECRET = process.env.DIAG_MS_CLIENT_SECRET!;
const URL = 'https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt';

async function getGraphToken(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const json: any = await res.json();
  return json.access_token;
}

async function main() {
  const saToken = await getSaToken();
  const graphToken = await getGraphToken();
  const resolved = await resolveShareUrlSmart(graphToken, URL);
  if (!resolved.item) throw new Error('could not resolve file');
  const bytes = await downloadDriveItemBytes(graphToken, resolved.item);
  if (!bytes) throw new Error('download failed');

  const result = await migrateFileToDocumentStore(PROJECT, saToken, AGENT_SOURCE_ID, {
    name: resolved.item.name,
    bytes: bytes.bytes,
    mimeType: bytes.contentType || 'text/plain',
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  console.error('cause:', e.cause);
  console.error(e.stack);
});
