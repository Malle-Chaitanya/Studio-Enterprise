// Proves the "copy mode" path works with ZERO connector/OAuth setup — using
// ConnectorsTest's app-only credentials (confirmed Sites.Read.All granted)
// to fetch the target file directly via Graph, bypassing every connector
// mechanism we've been fighting all day.
//   npx tsx src/spikes/_diag_direct_graph_download.ts
import 'dotenv/config';
import { resolveShareUrlSmart, downloadDriveItemBytes } from '../services/graphFiles.js';

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
  if (!res.ok) throw new Error(`token request failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function main() {
  const graphToken = await getGraphToken();
  console.log('got app-only graph token via ConnectorsTest credentials');
  const resolved = await resolveShareUrlSmart(graphToken, URL);
  console.log('resolved:', JSON.stringify(resolved, null, 2));
  if (resolved.item) {
    const bytes = await downloadDriveItemBytes(graphToken, resolved.item);
    console.log('downloaded bytes:', bytes?.bytes.length, 'contentType:', bytes?.contentType);
    console.log('content preview:', bytes?.bytes.toString('utf8').slice(0, 500));
  }
}
main().catch((e) => console.error('FAILED:', e.message, e.stack));
