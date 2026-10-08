/** Can we read spend programmatically? Enables the (read-only, free) Cloud Billing API on OUR
 *  project, then checks whether our SA can see the CUSTOMER's billing account at all.
 *  NOTE: actual per-SKU COST is not exposed by any Cloud Billing API — it comes from the
 *  Console or a BigQuery billing export. This probe establishes which of those we need. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const OUR = process.env.OUR_PROJECT || '231705905417';
const ACCT = process.env.BILLING_ACCOUNT || '01AA7A-D51438-1B1C01';
const token = await getSaToken();
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const en = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${OUR}/services/cloudbilling.googleapis.com:enable`,
  { method: 'POST', headers: h, body: '{}' },
);
console.log(`enable cloudbilling API -> HTTP ${en.status} ${(await en.text()).replace(/\s+/g, ' ').slice(0, 220)}`);

await new Promise((r) => setTimeout(r, 8000));
for (const [label, url] of [
  ['billing account', `https://cloudbilling.googleapis.com/v1/billingAccounts/${ACCT}`],
  ['agentmigrations billingInfo', 'https://cloudbilling.googleapis.com/v1/projects/agentmigrations/billingInfo'],
] as const) {
  const r = await fetch(url, { headers: h });
  console.log(`\n${label} -> HTTP ${r.status}\n  ${(await r.text()).replace(/\s+/g, ' ').slice(0, 300)}`);
}
process.exit(0);
