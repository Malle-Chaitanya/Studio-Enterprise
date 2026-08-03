/**
 * Read the ACTUAL Discovery Engine quota metrics for a project via the Service
 * Usage API — the real limit, current usage, and whether it's a per-day/minute
 * (resets) or absolute (needs an increase request) quota. Tells us if the
 * "Agent creation quota exceeded" is self-serve-raisable or a hard tier cap.
 *
 *   npx tsx src/_diag_quota_metrics.ts <projectNumber>
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';

const PROJECT = process.argv[2];

async function main() {
  if (!PROJECT) throw new Error('usage: npx tsx src/_diag_quota_metrics.ts <projectNumber>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  const token = await getSaToken(impersonate);

  const url =
    `https://serviceusage.googleapis.com/v1beta1/projects/${PROJECT}` +
    `/services/discoveryengine.googleapis.com/consumerQuotaMetrics?pageSize=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status}`);
    console.log(text.slice(0, 500));
    console.log('\n(If 403: the impersonated user lacks serviceusage.quotas.get — read the quota in Console → IAM & Admin → Quotas instead.)');
    process.exit(0);
  }
  const json = JSON.parse(text) as { metrics?: Record<string, unknown>[] };
  const hits = (json.metrics ?? []).filter((m) =>
    /agent|assistant/i.test(JSON.stringify(m.displayName ?? '') + JSON.stringify(m.metric ?? '')),
  );
  const show = hits.length ? hits : (json.metrics ?? []);
  console.log(`${hits.length ? 'Agent/assistant-related' : 'ALL'} quota metrics for ${PROJECT}:\n`);
  for (const m of show) {
    console.log(`• ${m.displayName ?? m.metric}`);
    const limits = (m as { consumerQuotaLimits?: { quotaBuckets?: { effectiveLimit?: string; defaultLimit?: string }[]; unit?: string }[] }).consumerQuotaLimits ?? [];
    for (const l of limits) {
      const b = l.quotaBuckets?.[0];
      console.log(`    unit=${l.unit}  effectiveLimit=${b?.effectiveLimit}  defaultLimit=${b?.defaultLimit}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
