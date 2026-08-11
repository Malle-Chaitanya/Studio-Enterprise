import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`https://logging.googleapis.com/v2/entries:list`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter: `timestamp>="2026-08-05T21:30:00Z" AND (protoPayload.resourceName:"sharepoint1" OR resource.labels.service:"discoveryengine.googleapis.com" OR jsonPayload.message:"sharepoint")`,
      orderBy: 'timestamp desc',
      pageSize: 50,
    }),
  });
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 6000));
}
main().catch((e) => console.error('FAILED:', e.message));
