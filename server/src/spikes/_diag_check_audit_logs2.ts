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
      filter: `timestamp>="2026-08-05T21:40:00Z" AND protoPayload.methodName:"RefreshToken"`,
      orderBy: 'timestamp desc',
      pageSize: 50,
    }),
  });
  console.log('=== RefreshToken-related ===');
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 4000));

  const res2 = await fetch(`https://logging.googleapis.com/v2/entries:list`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter: `timestamp>="2026-08-05T21:40:00Z" AND severity>=WARNING`,
      orderBy: 'timestamp desc',
      pageSize: 50,
    }),
  });
  console.log('\n=== WARNING+ severity entries ===');
  console.log('status:', res2.status);
  console.log((await res2.text()).slice(0, 6000));
}
main().catch((e) => console.error('FAILED:', e.message));
