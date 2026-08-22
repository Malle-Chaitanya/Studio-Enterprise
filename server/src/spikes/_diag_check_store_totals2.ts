import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { effectiveGeminiProject } from '../services/gemini.js';

const REMAINING = [
  'cf-knowledge-eng-hr',
  'confluence-test-spike-001-confluence',
  'e2e-itinfra-sales-confluence',
  'ee2ea155-208c-f111-ab0f-0022480a981d-file-daily-queri-rmshaobgj',
  'ee2ea155-208c-f111-ab0f-0022480a981d-file-daily-queri-rmshbdqsk',
  'ee2ea155-208c-f111-ab0f-0022480a981d-file-daily-queri-rmshbtm2x',
  'ee2ea155-208c-f111-ab0f-0022480a981d-file-migrate-age-rmshc1i02',
  'ee2ea155-208c-f111-ab0f-0022480a981d-file-migrate-agent-prd-ful',
  'ee2ea155-208c-f111-ab0f-0022480a981d-sharepoint',
  'spiketest-bqreal-msho3cbj-tbl-contacts',
];

async function fetchWithRetry(url: string, token: string, tries = 3): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const project = effectiveGeminiProject('studio-enterprise-migration');

  for (const id of REMAINING) {
    try {
      const body = await fetchWithRetry(
        `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${id}/branches/0/documents?pageSize=1000`,
        token,
      );
      const shown = body.documents?.length ?? 0;
      const more = body.nextPageToken ? '+ (more pages exist beyond 1000)' : '';
      console.log(`${id}: ${shown}${more}`);
    } catch (e) {
      console.log(`${id}: FAILED (${(e as Error).message})`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
