/**
 * Directly tests whether the Azure AD app's CURRENT permissions actually cover each
 * Microsoft Graph / Power Platform connector wired for Sales Profiler Agent — not by
 * reading Azure's permission list (which needs its own permission), but by making the
 * real, minimal API call each connector needs and recording the real result.
 *
 * Run: npx tsx src/spikes/_diag_check_all_graph_permissions.ts
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

async function mintToken(tenantId: string, clientId: string, clientSecret: string, scope: string): Promise<string | null> {
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) {
    console.log(`  TOKEN MINT FAILED for scope ${scope}:`, res.status, (await res.text()).slice(0, 300));
    return null;
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

async function check(name: string, permission: string, token: string, url: string, method = 'GET') {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, method });
  const body = await res.text();
  let short = body.slice(0, 200);
  try {
    const j = JSON.parse(body);
    short = j.error?.message || j.error?.code || short;
  } catch { /* keep raw */ }
  console.log(`${res.ok ? '✓' : '✗'} ${name} (needs ${permission}) — ${res.status} ${short}`);
}

async function main() {
  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  const graphToken = await mintToken(tenantId, clientId, clientSecret, 'https://graph.microsoft.com/.default');
  if (!graphToken) return;
  console.log('=== Microsoft Graph connectors ===');

  await check('Office 365 Users (directReports)', 'User.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/users/erik@filefuze.co/directReports');
  await check('Office 365 Groups (list)', 'Group.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/groups?$top=1');
  await check('Microsoft Bookings (list businesses)', 'Bookings.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/solutions/bookingBusinesses');
  await check('Microsoft To-Do (list lists, needs a user)', 'Tasks.ReadWrite', graphToken, 'https://graph.microsoft.com/v1.0/users/erik@filefuze.co/todo/lists');
  await check('Planner (list plans for a group)', 'Tasks.Read.All / Group.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/planner/plans?$top=1');
  await check('Microsoft 365 message center', 'ServiceMessage.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/admin/serviceAnnouncement/messages?$top=1');
  await check('Microsoft Entra ID (list users)', 'User.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/users?$top=1');
  await check('Microsoft Entra ID Protection (risky users)', 'IdentityRiskyUser.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/identityProtection/riskyUsers?$top=1');
  await check('Shifts for Teams (needs a real team id, testing list teams instead)', 'Team.ReadBasic.All', graphToken, 'https://graph.microsoft.com/v1.0/teams?$top=1');
  await check('Excel/Word Online (needs a real drive item; testing /me/drive as app-only, expected to need a user)', 'Files.Read.All', graphToken, 'https://graph.microsoft.com/v1.0/drives?$top=1');

  console.log('\n=== Non-Graph resources (different audience each) ===');
  const powerAppsToken = await mintToken(tenantId, clientId, clientSecret, 'https://service.powerapps.com/.default');
  if (powerAppsToken) await check('Power Apps for Makers (list apps)', 'Power Platform authorization (not a Graph permission)', powerAppsToken, 'https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2016-11-01');

  const powerPlatformToken = await mintToken(tenantId, clientId, clientSecret, 'https://api.powerplatform.com/.default');
  if (powerPlatformToken) await check('Power Platform for Admins', 'Power Platform authorization', powerPlatformToken, 'https://api.powerplatform.com/licensing/environments?api-version=2022-03-01-preview&$top=1');

  const formsToken = await mintToken(tenantId, clientId, clientSecret, 'https://forms.office.com/.default');
  if (formsToken) console.log('✓ Forms token minted OK (scope accepted) — endpoint shape not tested, no public list-all route');

  const flowToken = await mintToken(tenantId, clientId, clientSecret, 'https://service.flow.microsoft.com/.default');
  if (flowToken) await check('Human review / Standard approvals (Power Automate)', 'Power Platform authorization', flowToken, 'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments?api-version=2016-11-01&$top=1');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
