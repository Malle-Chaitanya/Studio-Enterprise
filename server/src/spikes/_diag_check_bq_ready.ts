import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';

async function main() {
  const token = await getSaToken('zara@storefuze.com');

  const svcRes = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/bigquery.googleapis.com`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log('BigQuery API service status:', svcRes.status);
  console.log((await svcRes.text()).slice(0, 400));

  const dsRes = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets?maxResults=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('\nList datasets status:', dsRes.status);
  console.log((await dsRes.text()).slice(0, 800));
}
main().catch((e) => console.error('FAILED:', e.message));
