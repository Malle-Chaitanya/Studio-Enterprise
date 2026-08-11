import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const LOCATION = 'us-west1';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  const json: any = await res.json();
  console.log('status:', res.status);
  for (const re of json.reasoningEngines ?? []) {
    console.log(re.name, '|', re.displayName, '| updateTime:', re.updateTime);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
