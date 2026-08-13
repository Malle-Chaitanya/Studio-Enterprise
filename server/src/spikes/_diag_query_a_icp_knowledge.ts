/** Does the deployed agent's grounding tool actually fire and return real content
 *  from the cficpprofiles/faqentries data stores, or does the search tool call itself
 *  never happen / always come back empty? A direct, simple lookup question (not a
 *  count/aggregation) isolates "is the reference wired" from "can search count rows".
 *  npx tsx src/spikes/_diag_query_a_icp_knowledge.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/3278736527202451456';
const PROBE = 'What is a Core ICP profile? Search your knowledge sources and quote exactly what you find, including which source it came from.';

async function main() {
  const saToken = await getSaToken('zara@storefuze.com');
  const url = `https://us-central1-aiplatform.googleapis.com/v1/${REASONING_ENGINE}:streamQuery?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'async_stream_query',
      input: { user_id: 'diag-icp-knowledge-test', message: PROBE },
    }),
  });
  console.log('status:', res.status);
  const text = await res.text();
  console.log(text.slice(0, 12000));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
