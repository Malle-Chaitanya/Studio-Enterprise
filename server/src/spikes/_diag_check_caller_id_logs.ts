import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const SINCE = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`https://logging.googleapis.com/v2/entries:list`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter: `timestamp>="${SINCE}" AND resource.type="aiplatform.googleapis.com/ReasoningEngine" AND (textPayload:"[caller-id]" OR textPayload:"[mint-token]")`,
      orderBy: 'timestamp desc',
      pageSize: 100,
    }),
  });
  const json = (await res.json()) as { entries?: { timestamp: string; textPayload?: string }[] };
  console.log('status:', res.status, 'entries:', json.entries?.length ?? 0);
  for (const e of (json.entries ?? []).reverse()) {
    console.log(e.timestamp, e.textPayload);
  }
}
main().catch((e) => { console.error('FAILED:', e.message); if (e.cause) console.error('CAUSE:', e.cause); });
