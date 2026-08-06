/**
 * Check RE state + Cloud Logging for execution errors.
 * Also try granting only the valid DE service agent.
 *
 * Usage: cd server && npx tsx src/spikes/_diag_re_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT   = 'studio-enterprise-migration';
const SA_PROJ_NUM  = '231705905417';
const GCP_PROJ_NUM = '521161651560';
const RE_ID        = '3647336805298077696';
const RE_PATH      = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;

const saTokenOwn = await getSaToken();

// ── Full RE details ───────────────────────────────────────────────────────────
console.log('=== Full RE details ===');
const reRes = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}`,
  { headers: { Authorization: `Bearer ${saTokenOwn}` } },
);
const reJson = await reRes.json() as Record<string, unknown>;
console.log(JSON.stringify(reJson, null, 2).slice(0, 2000));

// ── Cloud Logging: recent RE errors ──────────────────────────────────────────
console.log('\n=== Cloud Logging (RE errors, last 30 min) ===');
const now = new Date();
const thirtyMin = new Date(now.getTime() - 30 * 60 * 1000);
const logFilter = [
  `resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
  `resource.labels.reasoning_engine_id="${RE_ID}"`,
  `timestamp>="${thirtyMin.toISOString()}"`,
].join('\n');

const logRes = await fetch(
  `https://logging.googleapis.com/v2/entries:list`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${SA_PROJECT}`],
      filter: logFilter,
      orderBy: 'timestamp desc',
      pageSize: 20,
    }),
  },
);
console.log(`Logging status: ${logRes.status}`);
const logJson = await logRes.json() as { entries?: Array<Record<string, unknown>> };
const entries = logJson.entries ?? [];
console.log(`Found ${entries.length} log entries`);
for (const e of entries.slice(0, 10)) {
  const ts = e['timestamp'];
  const severity = e['severity'];
  const payload = e['textPayload'] ?? e['jsonPayload'] ?? e['protoPayload'];
  console.log(`[${severity}] ${ts}: ${JSON.stringify(payload).slice(0, 300)}`);
}

// ── Grant only valid DE service agent ─────────────────────────────────────────
console.log('\n=== Grant DE service agent → aiplatform.user (on our project) ===');
const deAgent = `service-${GCP_PROJ_NUM}@gcp-sa-discoveryengine.iam.gserviceaccount.com`;
const role = 'roles/aiplatform.user';
const member = `serviceAccount:${deAgent}`;

const getIam = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:getIamPolicy`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
  body: '{}',
});
const policy = await getIam.json() as { bindings?: { role: string; members: string[] }[] };
policy.bindings = policy.bindings ?? [];
const binding = policy.bindings.find(b => b.role === role);
if (binding?.members.includes(member)) {
  console.log(`Already granted: ${deAgent}`);
} else {
  if (binding) binding.members.push(member);
  else policy.bindings.push({ role, members: [member] });
  const setRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:setIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saTokenOwn}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  const setText = await setRes.text();
  console.log(`setIamPolicy ${setRes.status}: ${setRes.ok ? '✓ ' + deAgent : setText.slice(0, 200)}`);
}

// ── Check data store serving config ──────────────────────────────────────────
console.log('\n=== Check data store serving config ===');
const scRes = await fetch(
  `https://discoveryengine.googleapis.com/v1alpha/projects/${SA_PROJECT}/locations/global/collections/default_collection/dataStores/cf-knowledge-eng-hr/servingConfigs`,
  { headers: { Authorization: `Bearer ${saTokenOwn}` } },
);
console.log(`servingConfigs status: ${scRes.status}`);
const scJson = await scRes.json() as Record<string, unknown>;
console.log(JSON.stringify(scJson, null, 2).slice(0, 500));
