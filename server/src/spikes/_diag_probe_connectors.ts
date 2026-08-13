/**
 * Probe the deployed agent's live connector tools and print what it actually says.
 *
 * The Reasoning Engine logs elide payload content ("<elided>") and carry zero
 * WARNING+ entries even when a tool returns {"error": ...}, so the agent's own reply
 * is the only place the failure text exists.
 *
 *   cd server && npx tsx src/spikes/_diag_probe_connectors.ts
 *
 * Read-only against the customer's systems (list/search operations only).
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const RE = process.argv[2] || 'projects/231705905417/locations/us-central1/reasoningEngines/229588473240092672';

const PROBES: Array<[string, string]> = [
  ['JIRA', 'Use your Jira tools. List the Jira projects available, then search recent issues. Report the exact tool name you called and, if anything failed, the exact error text you received.'],
  ['DRIVE', 'Use your Google Drive tools to list files in the root folder. Report the exact tool name you called and, if it failed, the exact error text.'],
  ['HUBSPOT', 'Use your HubSpot tools to get a few companies. Report the exact tool name you called and, if it failed, the exact error text.'],
];

const token = await getSaToken();

for (const [label, message] of PROBES) {
  console.log(`\n================ ${label} ================`);
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${RE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'async_stream_query',
      input: { user_id: 'diag-probe', message },
    }),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);

  // Surface tool calls/responses and the final text, not the whole SSE stream.
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const body = line.startsWith('data:') ? line.slice(5).trim() : line;
    try {
      const j = JSON.parse(body) as any;
      const parts = j?.content?.parts ?? [];
      for (const p of parts) {
        if (p.functionCall) console.log(`  → CALL ${p.functionCall.name} ${JSON.stringify(p.functionCall.args ?? {}).slice(0, 200)}`);
        if (p.functionResponse) console.log(`  ← RESP ${p.functionResponse.name}: ${JSON.stringify(p.functionResponse.response ?? {}).slice(0, 500)}`);
        if (p.text) console.log(`  TEXT: ${String(p.text).replace(/\s+/g, ' ').slice(0, 700)}`);
      }
    } catch {
      if (body.length < 400) console.log('  raw: ' + body.slice(0, 300));
    }
  }
}
process.exit(0);
