/** Independently fetch the REAL rate sheet from OneDrive (bypassing the agent/integration
 *  entirely) and filter it by hand for limit=500000, to prove the agent's answer wasn't
 *  hallucinated. npx tsx src/spikes/_diag_verify_rateband_ground_truth.ts */
import 'dotenv/config';
const PROJECT = 'studio-enterprise-migration';
async function saToken() {
  const { getSaToken } = await import('../auth/google.js');
  return getSaToken();
}
const admin = await saToken();
async function sec(n: string) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${n}/versions/latest:access`, { headers: { Authorization: `Bearer ${admin}` } });
  const j = (await r.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}
const t = await sec('studio-enterprise-ms-graph-tenant-id');
const ci = await sec('studio-enterprise-ms-graph-client-id');
const cs = await sec('studio-enterprise-ms-graph-client-secret');
const tr = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ci, client_secret: cs, scope: 'https://graph.microsoft.com/.default' }),
});
const tok = (await tr.json() as { access_token: string }).access_token;

const USER = 'erik@filefuze.co';
const FILE_ID = '01NMN5O4EYOSCQPAGDLRAZ2BN6U36UPI4M';
const SHEET = 'demo-rate-sheet-2026 (2)';
const url = `https://graph.microsoft.com/v1.0/users/${USER}/drive/items/${FILE_ID}/workbook/worksheets('${encodeURIComponent(SHEET)}')/usedRange`;

const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
const json = (await res.json()) as { text?: string[][] };
const rows = json.text ?? [];
console.log('Header row:', JSON.stringify(rows[0]));
console.log(`\nAll ${rows.length - 1} data rows, as they really exist in the sheet:`);
for (let i = 1; i < rows.length; i++) console.log(`  ${JSON.stringify(rows[i])}`);

const newLimit = 500000;
console.log(`\nManually filtering for NewLimit=${newLimit} (min <= limit && max > limit):`);
const matches: string[] = [];
for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const min = Number(row[1]);
  const max = Number(row[2]);
  if (min <= newLimit && max > newLimit) {
    const line = `${row[0]}: ${row[3]} (${row[4]})`;
    matches.push(line);
    console.log(`  MATCH -> ${line}`);
  }
}
console.log(`\nGround-truth result: "${matches.join('; ')}"`);
console.log(`\nAgent's earlier answer was: "BBB: 3.25% (RM); BBB-: 3.50% (RM); BB+: 3.75% (RM); BB: 4.25% (RM); BB-: 4.75% (Relationship Pricing Committee)"`);
console.log(`\nMATCH: ${matches.join('; ') === 'BBB: 3.25% (RM); BBB-: 3.50% (RM); BB+: 3.75% (RM); BB: 4.25% (RM); BB-: 4.75% (Relationship Pricing Committee)'}`);
process.exit(0);
