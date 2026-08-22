/** Before deleting anything: find out exactly which data stores are actually holding
 *  the bulk of the 888,004 documents, via Cloud Monitoring (per-data-store time series),
 *  so we know what's safe to touch vs what backs a real, currently-used agent.
 *  READ-ONLY — deletes nothing.
 *   npx tsx src/spikes/_diag_check_doc_counts_per_store.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { effectiveGeminiProject } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const project = effectiveGeminiProject('studio-enterprise-migration');
  const projectNum = '231705905417';

  // Cloud Monitoring: current document count per data store, via the discoveryengine.googleapis.com metric.
  const now = new Date().toISOString();
  const url = `https://monitoring.googleapis.com/v3/projects/${projectNum}/timeSeries?filter=${encodeURIComponent(
    'metric.type="discoveryengine.googleapis.com/data_store/indexed_document_count"',
  )}&interval.endTime=${now}&interval.startTime=${new Date(Date.now() - 3600_000).toISOString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json() as { timeSeries?: { resource?: { labels?: Record<string, string> }; points?: { value?: { int64Value?: string } }[] }[]; error?: unknown };
  if (body.error) {
    console.log('Monitoring query failed:', JSON.stringify(body.error).slice(0, 500));
  } else {
    const rows = (body.timeSeries ?? [])
      .map((ts) => ({
        dataStore: ts.resource?.labels?.data_store_id ?? 'unknown',
        count: Number(ts.points?.[0]?.value?.int64Value ?? 0),
      }))
      .sort((a, b) => b.count - a.count);
    console.log(`Found ${rows.length} data store time series.`);
    for (const r of rows) console.log(`  ${r.dataStore}: ${r.count.toLocaleString()} documents`);
    console.log(`\nTotal: ${rows.reduce((s2, r) => s2 + r.count, 0).toLocaleString()}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
