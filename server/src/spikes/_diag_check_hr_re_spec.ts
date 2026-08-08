import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const LOCATION = 'us-central1';
const REASONING_ENGINE = '3571646424841977856';
const EXPECTED_STORE_ID = 'ad009852-cea1-436f-849d-5079a93fd5b4-file-neutara-hr-leave-poli';

async function main() {
  const saToken = await getSaToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${REASONING_ENGINE}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const text = await res.text();
  console.log('status:', res.status);
  console.log('references expected store id:', text.includes(EXPECTED_STORE_ID));
  console.log(text.slice(0, 6000));
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
