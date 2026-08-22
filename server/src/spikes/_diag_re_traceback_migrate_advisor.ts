import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const REASONING_ENGINE_ID = '6940215800812797952';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`https://logging.googleapis.com/v2/entries:list`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter:
        `timestamp>="2026-08-16T00:00:00Z" AND ` +
        `(protoPayload.resourceName:"${REASONING_ENGINE_ID}" OR ` +
        `resource.labels.reasoning_engine_id="${REASONING_ENGINE_ID}" OR ` +
        `jsonPayload.reasoningEngine:"${REASONING_ENGINE_ID}" OR ` +
        `textPayload:"${REASONING_ENGINE_ID}" OR ` +
        `textPayload:"NoneType")`,
      orderBy: 'timestamp desc',
      pageSize: 50,
    }),
  });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
