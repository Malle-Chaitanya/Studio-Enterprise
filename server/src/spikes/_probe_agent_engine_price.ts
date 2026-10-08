/** Public list price for Vertex AI Agent Engine (Reasoning Engine) SKUs. Lets us estimate
 *  what 76 idle engines cost per day without access to the customer's billing account —
 *  list price, not their negotiated/actual spend. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const token = await getSaToken();
const h = { Authorization: `Bearer ${token}` };
// Vertex AI service id in the public catalog.
const sr = await fetch('https://cloudbilling.googleapis.com/v1/services?pageSize=500', { headers: h });
const services = ((JSON.parse(await sr.text()) as { services?: any[] }).services ?? [])
  .filter((s) => /vertex|ai platform/i.test(s.displayName ?? ''));
for (const s of services) {
  let pageToken = '';
  for (let page = 0; page < 6; page++) {
    const u = `https://cloudbilling.googleapis.com/v1/${s.name}/skus?pageSize=500${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const r = await fetch(u, { headers: h });
    if (!r.ok) { console.log(`${s.displayName}: HTTP ${r.status}`); break; }
    const j = JSON.parse(await r.text()) as { skus?: any[]; nextPageToken?: string };
    for (const sku of j.skus ?? []) {
      if (!/reasoning engine|agent engine/i.test(sku.description ?? '')) continue;
      const p = sku.pricingInfo?.[0]?.pricingExpression;
      const tier = p?.tieredRates?.[p.tieredRates.length - 1]?.unitPrice;
      const usd = Number(tier?.units ?? 0) + Number(tier?.nanos ?? 0) / 1e9;
      console.log(`${(sku.description ?? '').padEnd(58)} $${usd.toFixed(6)} / ${p?.usageUnitDescription ?? '?'}  [${(sku.serviceRegions ?? []).slice(0, 2).join(',')}]`);
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
}
process.exit(0);
