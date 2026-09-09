/** Pull Cloud Logging entries for the Deal Desk Reasoning Engine and summarize them
 *  chronologically, specifically flagging any "Sending out request" that has no matching
 *  "Response received from the model" / gen_ai.choice within a few seconds — that gap IS
 *  the silent-stall bug (tool call completes, then nothing). Raw JSON dumps of this got
 *  truncated before reaching the actual failed turn, since the working retry sorts first
 *  (desc by timestamp) and is verbose — this prints one line per entry instead, oldest
 *  first, so the whole window fits and the gap is visible directly.
 *  npx tsx src/spikes/_diag_check_deal_desk_stall_logs.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const REASONING_ENGINE_ID = '3166608331401854976';
const SINCE = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

interface LogEntry {
  timestamp: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: { event?: string; finish_reason?: string; content?: unknown; message?: string };
  labels?: Record<string, string>;
}

async function fetchAll(saToken: string): Promise<LogEntry[]> {
  const all: LogEntry[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`https://logging.googleapis.com/v2/entries:list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceNames: [`projects/${PROJECT}`],
        filter:
          `timestamp>="${SINCE}" AND (resource.labels.reasoning_engine_id="${REASONING_ENGINE_ID}" ` +
          `OR jsonPayload.reasoningEngine:"${REASONING_ENGINE_ID}" ` +
          `OR protoPayload.resourceName:"${REASONING_ENGINE_ID}")`,
        orderBy: 'timestamp asc',
        pageSize: 200,
        pageToken,
      }),
    });
    if (!res.ok) {
      console.log('status:', res.status, await res.text());
      break;
    }
    const json = (await res.json()) as { entries?: LogEntry[]; nextPageToken?: string };
    all.push(...(json.entries ?? []));
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return all;
}

async function main() {
  const saToken = await getSaToken();
  const entries = await fetchAll(saToken);
  console.log(`Total entries: ${entries.length}\n`);

  let lastRequestSentAt: number | null = null;
  for (const e of entries) {
    const t = e.timestamp;
    const line =
      e.textPayload ??
      (e.jsonPayload?.event
        ? `event=${e.jsonPayload.event}`
        : e.jsonPayload?.finish_reason
          ? `gen_ai.choice finish_reason=${e.jsonPayload.finish_reason}`
          : e.jsonPayload
            ? JSON.stringify(e.jsonPayload).slice(0, 200)
            : '(empty)');
    const sev = e.severity && e.severity !== 'DEFAULT' ? ` [${e.severity}]` : '';
    console.log(`${t}${sev}  ${line}`);

    if (typeof line === 'string' && line.includes('Sending out request')) {
      if (lastRequestSentAt !== null) {
        console.log('  ^^^ NOTE: a previous "Sending out request" never got a matching response before this one — that gap is the silent-stall bug.');
      }
      lastRequestSentAt = Date.parse(t);
    }
    if (typeof line === 'string' && (line.includes('Response received from the model') || line.includes('finish_reason'))) {
      lastRequestSentAt = null;
    }
  }
  if (lastRequestSentAt !== null) {
    console.log('\n^^^ NOTE: the LAST "Sending out request" in this window never got a matching response logged at all.');
  }
}
main().catch((e) => {
  // Node's `fetch` collapses every network-level failure (DNS, TLS, connection reset,
  // proxy interference) into the same generic "fetch failed" message — the real reason
  // lives on `.cause`, which the default error logging drops. Printing it is the
  // difference between "try again" and actually knowing what broke.
  console.error('FAILED:', e.message);
  if (e.cause) console.error('CAUSE:', e.cause);
});
