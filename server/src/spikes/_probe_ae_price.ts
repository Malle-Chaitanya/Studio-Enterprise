import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const token = await getSaToken();
const h = { Authorization: `Bearer ${token}` };
let pageToken = '';
for (let page = 0; page < 30; page++) {
  const r = await fetch(
    `https://cloudbilling.googleapis.com/v1/services/C7E2-9256-1C43/skus?pageSize=500${pageToken ? `&pageToken=${pageToken}` : ''}`,
    { headers: h },
  );
  if (!r.ok) { console.log(`HTTP ${r.status}`); break; }
  const j = JSON.parse(await r.text()) as { skus?: any[]; nextPageToken?: string };
  for (const s of j.skus ?? []) {
    const d = String(s.description ?? '');
    if (!/reasoning|agent engine/i.test(d)) continue;
    if (!(s.serviceRegions ?? []).some((x: string) => /us-central1|global/.test(x))) continue;
    const p = s.pricingInfo?.[0]?.pricingExpression;
    console.log(`
${d}  [unit: ${p?.usageUnitDescription}]`);
    for (const tr of p?.tieredRates ?? []) {
      const u = tr.unitPrice;
      const usd = Number(u?.units ?? 0) + Number(u?.nanos ?? 0) / 1e9;
      console.log(`   from ${tr.startUsageAmount ?? 0}: $${usd.toPrecision(6)}`);
    }
  }
  if (!j.nextPageToken) break;
  pageToken = j.nextPageToken;
}
process.exit(0);
