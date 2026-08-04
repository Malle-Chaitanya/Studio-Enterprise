import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const PROJECT = '231705905417';
const ID = 'adk-website-live-test-2-web-adklivetest2';

async function main() {
  const saToken = await getSaToken();
  const collection = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection`;

  console.log('=== target sites ===');
  const tsRes = await fetch(`${collection}/dataStores/${ID}/siteSearchEngine/targetSites`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log(tsRes.status, JSON.stringify(await tsRes.json(), null, 2));

  console.log('\n=== indexed documents ===');
  const docRes = await fetch(`${collection}/dataStores/${ID}/branches/default_branch/documents?pageSize=5`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log(docRes.status, JSON.stringify(await docRes.json(), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
