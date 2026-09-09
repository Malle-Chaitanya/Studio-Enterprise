/** App-only chat-message POST is blocked ("only for import purposes" — confirmed live).
 *  Is a CHANNEL message post different? Teams Graph API has a separate app permission
 *  (ChannelMessage.Send) for that surface. Finds a real team+channel and tries posting.
 *  npx tsx src/spikes/_diag_try_channel_post.ts */
import 'dotenv/config';
const PROJECT = 'studio-enterprise-migration';
async function saToken() {
  const { getSaToken } = await import('../auth/google.js');
  return getSaToken();
}
const admin = await saToken();
async function sec(n: string) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${n}/versions/latest:access`, { headers: { Authorization: `Bearer ${admin}` } });
  const j = (await r.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}
const t = await sec('studio-enterprise-ms-graph-tenant-id');
const ci = await sec('studio-enterprise-ms-graph-client-id');
const cs = await sec('studio-enterprise-ms-graph-client-secret');
const tr = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ci, client_secret: cs, scope: 'https://graph.microsoft.com/.default' }),
});
const tok = (await tr.json() as { access_token: string }).access_token;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const GRAPH = 'https://graph.microsoft.com/v1.0';

const grRes = await fetch(`${GRAPH}/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName&$top=5`, { headers: H });
const grJson = (await grRes.json()) as { value?: Array<{ id: string; displayName: string }> };
const teams = grJson.value ?? [];
console.log(`Teams found: ${teams.map((t2) => t2.displayName).join(', ') || 'none'}`);
if (!teams.length) process.exit(0);

for (const team of teams) {
  const chRes = await fetch(`${GRAPH}/teams/${team.id}/channels?$select=id,displayName`, { headers: H });
  if (!chRes.ok) { console.log(`  ${team.displayName}: channel list failed ${chRes.status}`); continue; }
  const chJson = (await chRes.json()) as { value?: Array<{ id: string; displayName: string }> };
  const general = (chJson.value ?? []).find((c) => c.displayName === 'General') ?? chJson.value?.[0];
  if (!general) continue;
  console.log(`\nTrying channel post: team="${team.displayName}" channel="${general.displayName}"`);
  const postRes = await fetch(`${GRAPH}/teams/${team.id}/channels/${general.id}/messages`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ body: { contentType: 'html', content: '<p>CSGE migration probe: channel post test.</p>' } }),
  });
  console.log('  status:', postRes.status);
  const text = await postRes.text();
  console.log('  ', text.slice(0, 400));
  if (postRes.ok) break;
}
process.exit(0);
