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
      filter: `timestamp>="2026-08-06T01:20:00Z" AND (protoPayload.resourceName:"7415009660698099712" OR resource.labels.reasoning_engine_id="7415009660698099712" OR jsonPayload.reasoningEngine:"7415009660698099712")`,
      orderBy: 'timestamp desc',
      pageSize: 30,
    }),
  });
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 8000));
}
main().catch((e) => console.error('FAILED:', e.message));
