/** "Unsupported app only token" — SharePoint REST is picky about HOW the app-only token
 *  was minted. Try the v1.0 (resource=) endpoint vs v2.0 (.default scope), and a couple
 *  of endpoint shapes, to find the combination SharePoint accepts.
 *  npx tsx src/spikes/_probe_sp_token_variants.ts */
import 'dotenv/config';
const TENANT = process.env.MS_GRAPH_TENANT_ID!;
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID!;
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET!;
const SP = process.env.SP_HOST ?? 'filefuze.sharepoint.com';

async function v2(): Promise<string | null> {
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: `https://${SP}/.default` }),
  });
  return r.ok ? ((await r.json()) as any).access_token : null;
}
async function v1(): Promise<string | null> {
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, resource: `https://${SP}` }),
  });
  const t = await r.text();
  if (!r.ok) { console.log(`  v1 token failed: ${t.replace(/\s+/g, ' ').slice(0, 200)}`); return null; }
  return JSON.parse(t).access_token as string;
}

const paths = ['/_api/web/lists?$top=1', '/_api/site', '/_api/v2.0/drives', '/sites/SPOLimitedScopes/_api/web/lists?$top=1'];

for (const [label, getter] of [['v2.0 (.default)', v2], ['v1.0 (resource=)', v1]] as const) {
  const tok = await getter();
  console.log(`\n═══ ${label} ═══`);
  if (!tok) { console.log('  no token'); continue; }
  const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString('utf8')) as any;
  console.log(`  ver=${claims.ver} roles=${(claims.roles ?? []).join(',') || '(none)'}`);
  for (const p of paths) {
    const r = await fetch(`https://${SP}${p}`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json;odata=nometadata' } });
    const b = (await r.text()).replace(/\s+/g, ' ').slice(0, 120);
    console.log(`  ${String(r.status).padEnd(4)} ${p}   ${r.ok ? 'OK' : b}`);
  }
}

// Confirm the documented cause in OUR token: SharePoint REST accepts app-only tokens
// only when they were minted with a CERTIFICATE (appidacr=2), not a client secret
// (appidacr=1). This is a SharePoint-specific rule; Graph accepts both.
const t2 = await v2();
if (t2) {
  const c = JSON.parse(Buffer.from(t2.split('.')[1], 'base64').toString('utf8')) as any;
  console.log(`\n═══ token credential type ═══`);
  console.log(`  appidacr = ${c.appidacr}  (1 = client secret, 2 = certificate)`);
  console.log(`  ${c.appidacr === '1' ? 'CONFIRMED: secret-based token — SharePoint REST rejects these' : 'certificate-based'}`);
}
