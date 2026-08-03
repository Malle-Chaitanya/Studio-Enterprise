/** Query the authoritative Cloud Quotas API for the agent-related quotas +
 *  their actual limit values, to find what "Agent creation quota exceeded" maps to.
 *   npx tsx src/spikes/_diag_cloudquotas.ts <project> */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT] = process.argv.slice(2);
const SERVICES = ['discoveryengine.googleapis.com', 'agentregistry.googleapis.com', 'aiplatform.googleapis.com'];

async function main() {
  if (!PROJECT) throw new Error('usage: _diag_cloudquotas.ts <project>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}` };

  for (const svc of SERVICES) {
    const url = `https://cloudquotas.googleapis.com/v1/projects/${PROJECT}/locations/global/services/${svc}/quotaInfos?pageSize=500`;
    const r = await fetch(url, { headers: h });
    console.log(`\n===== ${svc} -> ${r.status} =====`);
    if (!r.ok) { console.log((await r.text()).replace(/\s+/g, ' ').slice(0, 200)); continue; }
    const j = (await r.json()) as { quotaInfos?: { quotaId?: string; metric?: string; isFixed?: boolean; quotaIncreaseEligibility?: unknown; dimensionsInfos?: { details?: { value?: string }; applicableLocations?: string[] }[] }[] };
    const infos = j.quotaInfos ?? [];
    // Show anything agent/assistant/create-related.
    const rel = infos.filter((q) => /agent|assistant|create/i.test(`${q.quotaId} ${q.metric}`));
    console.log(`${infos.length} quotas total; ${rel.length} agent/assistant/create-related:`);
    for (const q of rel) {
      const val = q.dimensionsInfos?.[0]?.details?.value ?? '(n/a)';
      console.log(`  ${q.quotaId}  metric=${q.metric}  value=${val}  fixed=${q.isFixed}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
