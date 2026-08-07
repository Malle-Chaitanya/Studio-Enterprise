/** Graph permissions are NOT SharePoint permissions.
 *
 * Google's SharePoint crawl connector authenticates against SharePoint's own REST API
 * (resource https://<tenant>.sharepoint.com), which needs APPLICATION permissions under
 * the "SharePoint" API — distinct from the identically-named ones under "Microsoft
 * Graph". An app with only Graph perms mints a SharePoint token fine and then gets 401
 * on every document read, which is exactly the connector's error.
 *
 * npx tsx src/spikes/_probe_sharepoint_api_perms.ts
 */
import 'dotenv/config';
const TENANT = process.env.MS_GRAPH_TENANT_ID!;
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID!;
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET!;
const SP_HOST = process.env.SP_HOST ?? 'filefuze.sharepoint.com';

async function tokenFor(resource: string) {
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      scope: `${resource}/.default`,
    }),
  });
  const t = await r.text();
  if (!r.ok) return { ok: false as const, detail: t.replace(/\s+/g, ' ').slice(0, 220) };
  const j = JSON.parse(t) as { access_token: string };
  const claims = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64').toString('utf8')) as { roles?: string[]; aud?: string };
  return { ok: true as const, token: j.access_token, roles: claims.roles ?? [], aud: claims.aud };
}

console.log('═══ Graph token ═══');
const g = await tokenFor('https://graph.microsoft.com');
console.log(g.ok ? `  aud=${g.aud}\n  roles=${g.roles.join(', ') || '(none)'}` : `  FAILED ${g.detail}`);

console.log(`\n═══ SharePoint token (${SP_HOST}) ═══`);
const s = await tokenFor(`https://${SP_HOST}`);
if (!s.ok) {
  console.log(`  FAILED ${s.detail}`);
} else {
  console.log(`  aud=${s.aud}`);
  console.log(`  roles=${s.roles.join(', ') || '(NONE — no SharePoint API permissions granted)'}`);

  // The call the crawl actually makes: read a document library over SharePoint REST.
  const r = await fetch(`https://${SP_HOST}/_api/web/lists`, {
    headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/json;odata=nometadata' },
  });
  const body = await r.text();
  console.log(`\n  GET /_api/web/lists -> ${r.status}`);
  console.log(`  ${body.replace(/\s+/g, ' ').slice(0, 260)}`);
  console.log(`\n  verdict: ${r.ok
    ? 'SharePoint REST works — the app CAN crawl documents'
    : 'SharePoint REST refused — this is the connector\'s "invalid credentials" failure'}`);
}
