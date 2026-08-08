import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const CHECK = [
  'ee2ea155-208c-f111-ab0f-0022480a981d-file-daily-queries-txt',
  'ee2ea155-208c-f111-ab0f-0022480a981d-file-migrate-agent-prd-ful',
  '48248234-cb90-f111-8077-0022480a981d-file-neutara-hr-leave-poli',
  'sp-filefuze-cddd60ea5b99_file',
];

async function main() {
  const saToken = await getSaToken();
  for (const id of CHECK) {
    const res = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${id}`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    console.log(id, '->', res.status === 200 ? 'STILL EXISTS' : `GONE (${res.status})`);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
