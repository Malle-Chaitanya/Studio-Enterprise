/**
 * Validate a Microsoft Graph app registration the way the connector runtime will use
 * it — client_credentials mint, then one real call per connector's permission.
 *
 * This is the "validate on save" probe in embryo, and it exists because a successful
 * token mint proves nothing: Entra happily returns a token for an app with NO
 * application permissions consented, and every Graph call then 403s. Only calling
 * Graph shows whether admin consent actually happened.
 *
 * Creates nothing, deploys nothing, costs no agent quota.
 *
 * npx tsx src/spikes/_probe_ms_graph_creds.ts
 */
import 'dotenv/config';

const TENANT = process.env.MS_GRAPH_TENANT_ID ?? '';
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET ?? '';
if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET in server/.env');
  process.exit(1);
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── 1. Mint a token exactly as the container does ─────────────────────────────
console.log('═══ 1. client_credentials token mint ═══');
const tokenRes = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  }),
});
const tokenText = await tokenRes.text();
if (!tokenRes.ok) {
  console.error(`  FAILED ${tokenRes.status}: ${tokenText.replace(/\s+/g, ' ').slice(0, 400)}`);
  process.exit(1);
}
const tokenJson = JSON.parse(tokenText) as { access_token?: string; expires_in?: number };
const token = tokenJson.access_token!;
console.log(`  ok — token minted, expires_in=${tokenJson.expires_in}s`);

// The token's `roles` claim lists the application permissions actually consented.
// Reading it is faster and clearer than inferring consent from 403s.
try {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')) as {
    roles?: string[]; app_displayname?: string; tid?: string;
  };
  console.log(`  app        : ${payload.app_displayname ?? '(unnamed)'}`);
  console.log(`  tenant     : ${payload.tid}`);
  console.log(`  roles      : ${payload.roles?.length ? payload.roles.join(', ') : '(NONE CONSENTED)'}`);
} catch {
  console.log('  (could not decode token claims)');
}

// ── 2. One real call per connector, mapped to the permission it needs ─────────
console.log('\n═══ 2. Graph calls per connector ═══');
// Each probe must exercise the permission it claims to test. Calling /users to
// "test Mail.Read" passes on User.Read.All and tells you nothing — a probe that can
// succeed without the permission is worse than no probe, because it reports a
// connector as ready and the failure resurfaces inside a live agent.
// So: resolve a real user and group first, then hit the actual resource.
const firstUser = await fetch(`${GRAPH}/users?$top=1&$select=id,userPrincipalName`, {
  headers: { Authorization: `Bearer ${token}` },
});
const userId = firstUser.ok
  ? ((await firstUser.json()) as { value?: Array<{ id?: string }> }).value?.[0]?.id
  : undefined;
const firstGroup = await fetch(`${GRAPH}/groups?$top=1&$select=id`, {
  headers: { Authorization: `Bearer ${token}` },
});
const groupId = firstGroup.ok
  ? ((await firstGroup.json()) as { value?: Array<{ id?: string }> }).value?.[0]?.id
  : undefined;
console.log(`  (resolved sample user=${userId ? 'yes' : 'no'}, group=${groupId ? 'yes' : 'no'})`);

const probes: Array<{ connector: string; needs: string; path: string; skip?: string }> = [
  { connector: 'SharePoint', needs: 'Sites.Read.All', path: '/sites?search=*&$top=1' },
  { connector: 'OneDrive', needs: 'Files.Read.All',
    path: userId ? `/users/${userId}/drive/root/children?$top=1` : '',
    skip: userId ? undefined : 'no user resolved' },
  { connector: 'Teams', needs: 'Team.ReadBasic.All', path: '/teams?$top=1' },
  { connector: 'Outlook', needs: 'Mail.Read',
    path: userId ? `/users/${userId}/messages?$top=1&$select=subject` : '',
    skip: userId ? undefined : 'no user resolved' },
  { connector: 'Planner', needs: 'Tasks.ReadWrite.All + Group.Read.All',
    path: groupId ? `/groups/${groupId}/planner/plans?$top=1` : '',
    skip: groupId ? undefined : 'no group resolved' },
];

const results: Array<{ connector: string; ok: boolean; detail: string }> = [];
for (const p of probes) {
  if (p.skip) {
    console.log(`
  ${p.connector.padEnd(11)} needs ${p.needs}`);
    console.log(`    SKIP ${p.skip}`);
    results.push({ connector: p.connector, ok: false, detail: `skipped: ${p.skip}` });
    continue;
  }
  const r = await fetch(`${GRAPH}${p.path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.text();
  let detail = '';
  if (r.ok) {
    const json = JSON.parse(body) as { value?: unknown[] };
    detail = `${(json.value ?? []).length} item(s) returned`;
  } else {
    const msg = /"message":\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? body.replace(/\s+/g, ' ').slice(0, 160);
    detail = `${r.status} ${msg.slice(0, 180)}`;
  }
  results.push({ connector: p.connector, ok: r.ok, detail });
  console.log(`\n  ${p.connector.padEnd(11)} needs ${p.needs}`);
  console.log(`    ${r.ok ? 'OK  ' : 'FAIL'} ${detail}`);
}

// ── 3. Verdict: separate PERMISSION from DATA ─────────────────────────────────
// A 403 means the permission is missing — the customer must act in Azure.
// A 404 means the permission is fine but the tenant has no such data (no OneDrive
// provisioned, no mailbox). Reporting those the same way would send an admin to
// Azure to grant something they already granted.
const roles = (() => {
  try {
    return (JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')) as { roles?: string[] }).roles ?? [];
  } catch {
    return [];
  }
})();

const NEEDED: Record<string, string[]> = {
  SharePoint: ['Sites.Read.All'],
  OneDrive: ['Files.Read.All'],
  Teams: ['Team.ReadBasic.All'],
  Outlook: ['Mail.Read'],
  Planner: ['Tasks.ReadWrite.All', 'Group.Read.All'],
};

console.log('\n════ verdict ════');
const missingAll = new Set<string>();
for (const r of results) {
  const needs = NEEDED[r.connector] ?? [];
  const missing = needs.filter((n) => !roles.includes(n));
  missing.forEach((m) => missingAll.add(m));
  const is403 = r.detail.startsWith('403');
  const is404 = r.detail.startsWith('404');
  const state = r.ok
    ? 'READY'
    : missing.length
      ? `NEEDS PERMISSION: ${missing.join(', ')}`
      : is404
        ? 'permission OK — no such data in this tenant (not a blocker)'
        : is403
          ? 'permission refused despite being granted — check admin consent was clicked'
          : r.detail;
  console.log(`  ${r.connector.padEnd(11)} ${state}`);
}

if (missingAll.size) {
  console.log(`\n  Add these to the app as APPLICATION permissions (not Delegated — there is no`);
  console.log(`  signed-in user when an agent calls Graph), then click "Grant admin consent":`);
  for (const m of [...missingAll].sort()) console.log(`    - Microsoft Graph / ${m}`);
} else {
  console.log('\n  No missing permissions for the probed connectors.');
}
