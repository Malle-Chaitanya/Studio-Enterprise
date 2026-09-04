/** Read the ACTUAL rate-band data live from Erik's real OneDrive file, via Microsoft
 *  Graph's Excel API -- the real ground truth the GetRateSheetBand connector needs
 *  to read. Proves full read access, not just file discovery.
 *  npx tsx src/spikes/_diag_read_real_ratesheet.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SECRET_PROJECT = 'studio-enterprise-migration';
const saToken = await getSaToken();

async function readSecret(secretId: string): Promise<string> {
  const url = `https://secretmanager.googleapis.com/v1/projects/${SECRET_PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

const tenantId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-tenant-id');
const clientId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-id');
const clientSecret = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-secret');

const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }),
});
const { access_token } = (await tokenRes.json()) as { access_token: string };
const gh = { Authorization: `Bearer ${access_token}` };

const USER = 'erik@filefuze.co';
const FILE_ID = '01NMN5O4EYOSCQPAGDLRAZ2BN6U36UPI4M';

// List worksheets in the file.
const wsRes = await fetch(`https://graph.microsoft.com/v1.0/users/${USER}/drive/items/${FILE_ID}/workbook/worksheets`, { headers: gh });
const wsJson = (await wsRes.json()) as { value?: Array<{ id: string; name: string }>; error?: unknown };
if (!wsJson.value) {
  console.log('Worksheets fetch failed:', JSON.stringify(wsJson).slice(0, 500));
  process.exit(0);
}
console.log(`Worksheets: ${wsJson.value.map((w) => w.name).join(', ')}`);

// Read the used range of the first worksheet.
const sheetName = wsJson.value[0].name;
const rangeRes = await fetch(
  `https://graph.microsoft.com/v1.0/users/${USER}/drive/items/${FILE_ID}/workbook/worksheets('${encodeURIComponent(sheetName)}')/usedRange`,
  { headers: gh },
);
const rangeJson = (await rangeRes.json()) as { values?: unknown[][]; error?: unknown };
if (!rangeJson.values) {
  console.log('Range fetch failed:', JSON.stringify(rangeJson).slice(0, 500));
  process.exit(0);
}
console.log(`\nReal live data (${rangeJson.values.length} rows):`);
for (const row of rangeJson.values) console.log('  ' + row.join(' | '));
process.exit(0);
