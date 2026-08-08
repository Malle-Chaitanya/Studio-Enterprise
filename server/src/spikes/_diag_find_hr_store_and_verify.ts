import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { verifyDocumentsIndexed } from '../services/geminiDataStore.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

async function main() {
  const saToken = await getSaToken();
  for (const project of ['231705905417', '72860638029']) {
    const res = await fetch(
      `${HOST}/projects/${project}/locations/global/collections/default_collection/dataStores`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    const text = await res.text();
    if (!res.ok) {
      console.log(`project ${project}: list failed ${res.status}: ${text.slice(0, 200)}`);
      continue;
    }
    const j = JSON.parse(text) as { dataStores?: { name: string; displayName?: string }[] };
    const matches = (j.dataStores ?? []).filter((d) => /neutara/i.test(d.displayName ?? ''));
    console.log(`project ${project}: ${j.dataStores?.length ?? 0} total stores, neutara matches:`, JSON.stringify(matches, null, 2));
    for (const m of matches) {
      const id = m.name.split('/').pop()!;
      const indexed = await verifyDocumentsIndexed(project, saToken, id);
      console.log(`  -> ${id} in project ${project}: indexed = ${indexed}`);
    }
  }
}
main().catch((e) => console.error('FAILED:', e.message));
