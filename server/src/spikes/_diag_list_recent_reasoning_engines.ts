// Lists Reasoning Engines in this project/location, newest first, to check
// whether a timed-out deploy actually finished server-side despite the client
// giving up waiting.
//   npx tsx src/spikes/_diag_list_recent_reasoning_engines.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const LOCATION = 'us-central1';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines?pageSize=20`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('status:', res.status);
  const json = (await res.json()) as { reasoningEngines?: { name?: string; displayName?: string; createTime?: string }[] };
  const sorted = (json.reasoningEngines ?? []).sort((a, b) => (b.createTime ?? '').localeCompare(a.createTime ?? ''));
  for (const e of sorted.slice(0, 10)) {
    console.log(`${e.createTime}  ${e.displayName}  ${e.name}`);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
