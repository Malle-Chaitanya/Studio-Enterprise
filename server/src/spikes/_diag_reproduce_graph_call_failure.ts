/**
 * The token mint succeeded, which proves nothing about whether the actual Graph call
 * works — client_credentials + .default always mints fine regardless of which specific
 * permissions the app has been granted. Make the EXACT real call one of the failing
 * tools makes (Office 365 Users' directReports, matching the "who reports to
 * erik@filefuze.co" test in the chat) and see Microsoft's own real error.
 *
 * Run: npx tsx src/spikes/_diag_reproduce_graph_call_failure.ts
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

async function main() {
  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  console.log('token minted OK, calling real Graph endpoints now...\n');

  const calls = [
    { name: 'Office 365 Users - directReports (erik@filefuze.co)', url: 'https://graph.microsoft.com/v1.0/users/erik@filefuze.co/directReports' },
    { name: 'Microsoft Bookings - list businesses as admin', url: 'https://graph.microsoft.com/v1.0/solutions/bookingBusinesses' },
    { name: 'Power Apps for Makers - Get Apps (v1.0 has no such path; testing the REAL PowerApps host instead)', url: 'https://api.powerapps.com/providers/Microsoft.PowerApps/apps?api-version=2016-11-01' },
  ];

  for (const c of calls) {
    const res = await fetch(c.url, { headers: { Authorization: `Bearer ${access_token}` } });
    const body = await res.text();
    console.log(`=== ${c.name} ===`);
    console.log('status:', res.status);
    console.log('body:', body.slice(0, 500));
    console.log('');
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
