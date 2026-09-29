/**
 * The deployed Sales Profiler Agent reports "authentication error" for two tools that work
 * fine in the source Copilot Studio agent:
 *   - "Call Planner Api" (shared_planner) reading/updating plan S28A16UF90Kuedbwg8h9vWUACvZQ
 *     and task X5yhUHOQ60m...
 *   - "Get Apps As Administrator" (shared_powerplatformforadmins), listing Power Platform apps
 *     as an admin
 *
 * Reproduce both calls directly with the real stored credentials and the real IDs the user's
 * own chat used, to see Microsoft's real error rather than guess.
 *
 * Run: npx tsx src/spikes/_diag_planner_powerplatform_admin_failures.ts
 */
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

async function call(name: string, url: string, token: string, method = 'GET', body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let short = text.slice(0, 500);
  try {
    const j = JSON.parse(text);
    short = JSON.stringify(j.error ?? j).slice(0, 500);
  } catch { /* keep raw */ }
  console.log(`${res.ok ? '✓' : '✗'} ${name} — ${res.status}`);
  console.log('   ', short);
}

async function main() {
  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  console.log('=== Planner (shared_planner) ===');
  const graphToken = await mintToken(tenantId, clientId, clientSecret, 'https://graph.microsoft.com/.default');
  if (graphToken) {
    await call(
      'GET plan S28A16UF90Kuedbwg8h9vWUACvZQ',
      "https://graph.microsoft.com/v1.0/planner/plans/S28A16UF90Kuedbwg8h9vWUACvZQ",
      graphToken,
    );
    await call(
      'GET plan tasks',
      "https://graph.microsoft.com/v1.0/planner/plans/S28A16UF90Kuedbwg8h9vWUACvZQ/tasks",
      graphToken,
    );
  }

  console.log('\n=== Power Platform for Admins (shared_powerplatformforadmins) ===');
  const ppToken = await mintToken(tenantId, clientId, clientSecret, 'https://api.powerplatform.com/.default');
  if (ppToken) {
    await call(
      'GET environments as admin',
      'https://api.powerplatform.com/licensing/environments?api-version=2022-03-01-preview&$top=1',
      ppToken,
    );
    await call(
      'GET apps as admin (appmanagement)',
      'https://api.powerplatform.com/appmanagement/apps?api-version=2022-11-01&$top=1',
      ppToken,
    );
  }
  // Also try the OLDER api.powerapps.com host — Microsoft's real "Power Platform for Admins"
  // connector predates api.powerplatform.com and some ops (like GetAppsAsAdmin) may still be
  // published only on the older host.
  const powerAppsToken = await mintToken(tenantId, clientId, clientSecret, 'https://service.powerapps.com/.default');
  if (powerAppsToken) {
    await call(
      'GET apps as admin (api.powerapps.com, scope=admin)',
      'https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2016-11-01&$filter=environment%20eq%20%27~default%27&scope=admin',
      powerAppsToken,
    );
    await call(
      'GET apps as admin (api.powerapps.com, no filter, scope=admin)',
      'https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2016-11-01&scope=admin',
      powerAppsToken,
    );
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
