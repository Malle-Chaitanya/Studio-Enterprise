/**
 * Full picture for Sales Profiler Agent's two live-failing tools: the exact connector +
 * operation + fixed inputs + connectionAuthMode Copilot Studio itself captured, then a real
 * app-only call against the REAL path (not a guess) to see if Microsoft actually rejects it.
 *
 * Run: npx tsx src/spikes/_diag_sales_profiler_planner_pp_detail.ts
 */
const { getDb, connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { getSaToken } = await import('../auth/google.js');

const PROJECT = 'agentmigrations';
const SCOPE_PREFIX = 'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph';
const HOST = 'https://secretmanager.googleapis.com/v1';

async function readSecret(saToken: string, secretId: string): Promise<string> {
  const url = `${HOST}/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

async function mintToken(tenantId: string, clientId: string, clientSecret: string, scope: string) {
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`  TOKEN MINT FAILED for scope ${scope}:`, res.status, JSON.stringify(body).slice(0, 400));
    return null;
  }
  return (body as { access_token: string }).access_token;
}

async function call(name: string, url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let short = text.slice(0, 500);
  try { short = JSON.stringify(JSON.parse(text)).slice(0, 500); } catch { /* keep raw */ }
  console.log(`${res.ok ? '✓' : '✗'} ${name} — ${res.status}`);
  console.log('   ', short);
}

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb();

  const agent = await db.collection('agentIRCache').findOne({
    sourceId: 'c9176288-690a-4629-9d0a-cd8c86a29f2a',
  } as never);
  if (!agent) throw new Error('agent not found');

  const tools = ((agent as any).ir?.agentTools ?? []).filter(
    (t: any) => t.kind === 'connector' && (t.connectorId === 'shared_planner' || t.connectorId === 'shared_powerplatformadminv2'),
  );
  console.log('=== Real captured tools ===');
  for (const t of tools) {
    console.log(JSON.stringify({
      name: t.name, connectorId: t.connectorId, operationId: t.operationId,
      connectionAuthMode: t.connectionAuthMode, inputs: t.inputs,
    }, null, 2));
  }

  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  console.log('\n=== Live app-only test: Power Platform for Admins V2 — Get-AdminApps ===');
  const environmentId = '7f9f87cc-464e-e470-95bb-363b7f227200';
  for (const scope of ['https://api.powerplatform.com/.default', 'https://service.powerapps.com/.default']) {
    const token = await mintToken(tenantId, clientId, clientSecret, scope);
    if (!token) continue;
    if (scope === 'https://api.powerplatform.com/.default') {
      await call(
        `GET apps as admin via api.powerplatform.com (scope=${scope})`,
        `https://api.powerplatform.com/powerapps/environments/${environmentId}/apps?api-version=2020-06-01`,
        token,
      );
    } else {
      await call(
        `GET apps as admin via api.powerapps.com (scope=${scope})`,
        `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/${environmentId}/apps?api-version=2020-06-01`,
        token,
      );
    }
  }

  console.log('\n=== Live app-only test: Planner — the exact captured connector ops ===');
  const graphToken = await mintToken(tenantId, clientId, clientSecret, 'https://graph.microsoft.com/.default');
  if (graphToken) {
    for (const t of tools.filter((x: any) => x.connectorId === 'shared_planner')) {
      const planId = (t.inputs ?? []).find((i: any) => /id$/i.test(i.name))?.value;
      console.log('planId from captured tool inputs:', planId, '| operationId:', t.operationId);
    }
    await call('GET plan DETAILS (real captured op path)', 'https://graph.microsoft.com/v1.0/planner/plans/S28A16UF90Kuedbwg8h9vWUACvZQ/details', graphToken);
  }
}

main()
  .then(() => closeDb())
  .catch((e) => {
    console.error('FAILED:', e);
  })
  .finally(() => process.exit(0));
