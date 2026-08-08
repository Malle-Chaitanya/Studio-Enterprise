import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const LOCATION = 'us-west1';
const RE_ID = '7415009660698099712';

async function main() {
  const saToken = await getSaToken();
  // Try the base operations collection with a filter
  const res = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/operations?filter=${encodeURIComponent(`name="projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${RE_ID}"`)}`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('=== filtered operations ===');
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 3000));

  // Also fetch the reasoning engine resource itself for full detail
  const res2 = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${RE_ID}`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('\n=== reasoning engine resource ===');
  console.log('status:', res2.status);
  console.log((await res2.text()).slice(0, 4000));
}
main().catch((e) => console.error('FAILED:', e.message));
