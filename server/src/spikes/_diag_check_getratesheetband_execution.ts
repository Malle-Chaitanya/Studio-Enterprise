/** Check the ACTUAL most recent execution of the "GetRateSheetBand" Application Integration
 *  flow — request/response payloads, not just "it deployed" — to answer definitively whether
 *  it's really pulling live data from the OneDrive Excel table, or silently failing/returning
 *  something else. Same host/location pattern as services/applicationIntegration.ts.
 *  npx tsx src/spikes/_diag_check_getratesheetband_execution.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1'; // matches services/applicationIntegration.ts's hardcoded LOCATION
const INTEGRATION = process.argv[2] || 'GetRateSheetBand';

async function main() {
  const saToken = await getSaToken();
  const headers = { Authorization: `Bearer ${saToken}` };

  const listUrl =
    `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}` +
    `/integrations/${INTEGRATION}/executions?pageSize=5&orderBy=updateTime desc`;
  const res = await fetch(listUrl, { headers });
  console.log('list status:', res.status);
  const text = await res.text();
  if (!res.ok) {
    console.log(text.slice(0, 3000));
    return;
  }
  const json = JSON.parse(text) as { executions?: { name: string; executionState?: string; createTime?: string }[] };
  const executions = json.executions ?? [];
  console.log(`Found ${executions.length} execution(s).\n`);

  for (const exec of executions.slice(0, 3)) {
    console.log('---', exec.name, exec.executionState, exec.createTime, '---');
    const detailRes = await fetch(
      `https://${LOCATION}-integrations.googleapis.com/v1/${exec.name}`,
      { headers },
    );
    const detailJson = (await detailRes.json()) as {
      eventExecutionDetails?: {
        eventExecutionState?: string;
        eventExecutionSnapshot?: { eventParams?: { parameters?: { key: string; value?: Record<string, unknown> }[] } }[];
      };
    };
    console.log(`  detail status: ${detailRes.status}, overall state: ${detailJson.eventExecutionDetails?.eventExecutionState}`);
    const snapshots = detailJson.eventExecutionDetails?.eventExecutionSnapshot ?? [];
    console.log(`  ${snapshots.length} checkpoint(s) — showing the LAST one's params:`);
    const last = snapshots[snapshots.length - 1];
    for (const p of last?.eventParams?.parameters ?? []) {
      console.log(`    ${p.key}:`, JSON.stringify(p.value).slice(0, 500));
    }
    console.log();
  }
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  if (e.cause) console.error('CAUSE:', e.cause);
});
