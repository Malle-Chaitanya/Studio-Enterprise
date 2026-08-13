/** Does the deployed reasoning engine actually have a VertexAiSearchTool pointing at
 *  the right Dataverse-snapshot data store resource paths, or did the deploy just
 *  CLAIM it wired the reference without it actually being there? Inspect the real
 *  Reasoning Engine resource directly.
 *  npx tsx src/spikes/_diag_check_grounding_reference.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/3278736527202451456';

async function main() {
  const saToken = await getSaToken('zara@storefuze.com');
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${REASONING_ENGINE}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log('status:', res.status);
  const json = await res.json();
  const text = JSON.stringify(json, null, 2);
  // Print only the parts that mention the data stores or search tools — the full spec
  // is huge (instruction text, every tool schema) and most of it isn't relevant here.
  const lines = text.split('\n');
  const hits = lines.filter((l, i) =>
    /datastore|dataStore|vertexAiSearch|VertexAiSearchTool|cficpprofiles|faqentries|resourcePath|resource_path/i.test(l)
    || (i > 0 && /datastore|dataStore|vertexAiSearch|resourcePath/i.test(lines[i - 1] ?? '')),
  );
  console.log(`\n${hits.length} matching line(s):`);
  console.log(hits.join('\n'));
  if (hits.length === 0) {
    console.log('\nNO MATCHES AT ALL in the full spec — dumping first 4000 chars for context:');
    console.log(text.slice(0, 4000));
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
