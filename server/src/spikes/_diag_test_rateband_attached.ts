/** Ask the deployed test-clone agent a question that requires calling get_rate_sheet_band,
 *  and confirm the tool actually fires and returns real data (structural evidence, not
 *  prose). npx tsx src/spikes/_diag_test_rateband_attached.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const RE = 'projects/505103737920/locations/us-central1/reasoningEngines/969916040500740096';

async function ask(message: string) {
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'rateband-attach-test', message } }),
  });
  const raw = await res.text();
  console.log(`\n>>> ${message}`);
  console.log(`status: ${res.status}`);
  const calledTool = /"name":\s*"get_rate_sheet_band"/.test(raw);
  const hasFunctionResponse = /"functionResponse"/.test(raw);
  console.log(`tool called (get_rate_sheet_band): ${calledTool}`);
  console.log(`has functionResponse frame: ${hasFunctionResponse}`);
  const text = [...raw.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } })
    .join('')
    .trim();
  console.log(`answer: ${text.slice(0, 500)}`);
  return { calledTool, hasFunctionResponse, raw };
}

await ask('What rate and approval tier applies for a credit limit of 2,500,000?');
process.exit(0);
