import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const LOCATION = 'us-west1';
const RE_ID = '7415009660698099712';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${RE_ID}/operations`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
