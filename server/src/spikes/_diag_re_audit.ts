/**
 * Check RE methods + enable audit logging + check current IAM.
 * Usage: cd server && npx tsx src/spikes/_diag_re_audit.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT  = 'studio-enterprise-migration';
const SA_PROJ_NUM = '231705905417';
const RE_ID       = '6740183849394765824';
const RE_PATH     = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;
const tok = await getSaToken();

// ── 1. RE metadata + classMethods ─────────────────────────────────────────────
console.log('=== 1. RE metadata ===');
const re = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const reJson = await re.json() as Record<string, unknown>;
console.log(`state: ${reJson['state']}`);
console.log(`display: ${reJson['displayName']}`);
const methods = reJson['classMethods'] as string[] | undefined;
console.log(`classMethods (${methods?.length ?? 0}):`);
for (const m of methods ?? []) console.log(`  ${m}`);

// ── 2. Enable Data Access audit logs for aiplatform.googleapis.com ────────────
console.log('\n=== 2. Enable audit logs ===');
const getIam = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:getIamPolicy`,
  { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: '{}' },
);
const policy = await getIam.json() as {
  bindings?: { role: string; members: string[] }[];
  auditConfigs?: { service: string; auditLogConfigs: { logType: string }[] }[];
};

const svc = 'aiplatform.googleapis.com';
policy.auditConfigs = policy.auditConfigs ?? [];
const existing = policy.auditConfigs.find(a => a.service === svc);
if (existing) {
  console.log(`Audit config already exists for ${svc}:`, JSON.stringify(existing.auditLogConfigs));
} else {
  policy.auditConfigs.push({
    service: svc,
    auditLogConfigs: [{ logType: 'DATA_READ' }, { logType: 'DATA_WRITE' }],
  });
  const setRes = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${SA_PROJECT}:setIamPolicy`,
    { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }) },
  );
  console.log(`Audit log setup: ${setRes.status} ${setRes.ok ? '✓ DATA_READ + DATA_WRITE enabled' : (await setRes.text()).slice(0, 200)}`);
}

// ── 3. Current IAM bindings for RE access ─────────────────────────────────────
console.log('\n=== 3. Current IAM (aiplatform roles) ===');
for (const b of policy.bindings ?? []) {
  if (b.role.includes('aiplatform') || b.role.includes('discoveryengine') || b.role.includes('viewer')) {
    console.log(`  ${b.role}: ${b.members.slice(0, 3).join(', ')}`);
  }
}

// ── 4. Test RE with query (not stream_query) ──────────────────────────────────
console.log('\n=== 4. Test :query endpoint ===');
const qr = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:query`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { user_id: 'test', message: 'hello' } }),
  },
);
console.log(`:query ${qr.status}: ${(await qr.text()).slice(0, 200)}`);

// ── 5. Broad Cloud Logging (all severity >= WARNING, last 30min) ───────────────
console.log('\n=== 5. All WARNING+ logs (last 30min) ===');
const t30 = new Date(Date.now() - 30 * 60 * 1000);
const lr = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${SA_PROJECT}`],
    filter: [
      `resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
      `resource.labels.reasoning_engine_id="${RE_ID}"`,
      `timestamp>="${t30.toISOString()}"`,
      `severity>="WARNING"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 20,
  }),
});
const lj = await lr.json() as { entries?: Array<Record<string, unknown>> };
console.log(`${lr.status} — ${(lj.entries ?? []).length} entries`);
for (const e of lj.entries ?? []) {
  const pay = e['textPayload'] ?? e['jsonPayload'] ?? e['protoPayload'];
  console.log(`[${e['severity']}] ${String(e['timestamp']).slice(11, 19)}: ${JSON.stringify(pay).slice(0, 400)}`);
}
