/** Dump the RAW Graph workbook/tables('{id}')/range response to see the exact text grid
 *  shape my generic translator's zip-into-rows logic operates on.
 *  npx tsx src/spikes/_diag_dump_excel_table_range.ts */
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

const drive = 'b!XZcRew90a0OtJxtF_HAgX_9Z9KMdL4xKg_XOXJJGBn394Z24VXHgT6JKgGLvHkNe';
const file = '01NMN5O4EYOSCQPAGDLRAZ2BN6U36UPI4M';
const table = '{CB5CBA59-5C77-4449-AF23-ED63BCFF813F}';
const url = `https://graph.microsoft.com/v1.0/drives/${drive}/items/${file}/workbook/tables('${encodeURIComponent(table)}')/range`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
console.log('status:', res.status);
const json = (await res.json()) as { text?: unknown[][] };
console.log('text grid (first 4 rows):');
for (const row of (json.text ?? []).slice(0, 4)) console.log(JSON.stringify(row));
process.exit(0);
