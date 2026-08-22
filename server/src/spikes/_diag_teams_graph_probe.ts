/**
 * What can an APP-ONLY Graph token actually do with Teams? Layer by layer.
 *
 * Written because `ChannelMessage.Send` does not appear in the Entra APPLICATION permission
 * list. If that is right, app-only posting to a channel is not merely unpermitted but
 * UNSUPPORTED — Microsoft's only app-only write path for channel messages is
 * `Teamwork.Migrate.All`, which requires the team to be in migration mode. That would make
 * the keep-Teams path READ-ONLY, which contradicts what the connector currently promises.
 *
 * Probing rather than reasoning, because the answer changes the product: a read-only
 * keep-Teams option is still worth offering, but it must not claim it can post.
 *
 * Each layer is independent so a failure localises instead of collapsing the whole run:
 *   1  token mints, and WHICH roles it carries (ground truth for what was consented)
 *   2  list the tenant's teams                      Team.ReadBasic.All
 *   3  list channels in a team                      Channel.ReadBasic.All
 *   4  READ channel messages                        ChannelMessage.Read.All + protected APIs
 *   5  list a user's chats                          Chat.Read.All / Chat.ReadWrite.All
 *   6  READ chat messages                           same + protected APIs
 *   7  WRITE a channel message                      the question this spike exists for
 *
 * Layer 7 posts to a channel. It is the ONLY write, it is clearly marked as a probe, and it
 * only runs when a team+channel are discovered — nothing is created.
 *
 *   cd server && npx tsx src/spikes/_diag_teams_graph_probe.ts [userEmail]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const USER = process.argv[2] || 'alex@filefuze.co';
const PROJECT = 'studio-enterprise-migration';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const admin = await getSaToken();
async function secret(name: string): Promise<string> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${admin}` } },
  );
  const j = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}

const tenant = await secret('studio-enterprise-ms-graph-tenant-id');
const clientId = await secret('studio-enterprise-ms-graph-client-id');
const clientSecret = await secret('studio-enterprise-ms-graph-client-secret');

// ---- layer 1: token + roles ------------------------------------------------------------
const tokRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  }),
});
const tok = (await tokRes.json()) as { access_token?: string; error_description?: string };
if (!tok.access_token) {
  console.log(`L1 FAIL token: ${tok.error_description?.slice(0, 200)}`);
  process.exit(0);
}
const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1], 'base64').toString('utf8')) as {
  roles?: string[];
};
const roles = (claims.roles ?? []).sort();
console.log(`L1 PASS token minted, ${roles.length} application permission(s):`);
for (const r of roles) console.log(`        ${r}`);

const TEAMS_ROLES = [
  'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All',
  'Chat.Read.All', 'Chat.ReadWrite.All', 'ChannelMessage.Send', 'Teamwork.Migrate.All',
];
console.log('\n     Teams-relevant roles:');
for (const r of TEAMS_ROLES) console.log(`        ${roles.includes(r) ? 'GRANTED ' : 'absent  '} ${r}`);

const H = { Authorization: `Bearer ${tok.access_token}` };
async function g(path: string): Promise<{ ok: boolean; status: number; body: string; json: unknown }> {
  const res = await fetch(`${GRAPH}${path}`, { headers: H });
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, body: body.replace(/\s+/g, ' ').slice(0, 300), json };
}

/** Graph's error CODE, which distinguishes a missing permission from the protected-API gate. */
function why(body: string): string {
  if (/Unknown Error|evaluation mode|license|Payment/i.test(body)) return 'PROTECTED-API / licensing gate';
  if (/ErrorAccessDenied|Authorization_RequestDenied|Forbidden/i.test(body)) return 'permission refused';
  if (/ResourceNotFound|NotFound/i.test(body)) return 'not found (wrong id or no such resource)';
  return 'see body';
}

// ---- layer 2: teams --------------------------------------------------------------------
let teamId = '';
{
  const r = await g(`/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName&$top=10`);
  if (r.ok) {
    const v = (r.json as { value?: Array<{ id: string; displayName: string }> }).value ?? [];
    console.log(`\nL2 PASS ${v.length} team(s): ${v.map((t) => t.displayName).join(', ') || '(none)'}`);
    teamId = v[0]?.id ?? '';
  } else {
    console.log(`\nL2 FAIL ${r.status} — ${why(r.body)}\n        ${r.body}`);
  }
}

// ---- layer 3: channels -----------------------------------------------------------------
let channelId = '';
if (teamId) {
  const r = await g(`/teams/${teamId}/channels`);
  if (r.ok) {
    const v = (r.json as { value?: Array<{ id: string; displayName: string }> }).value ?? [];
    console.log(`L3 PASS ${v.length} channel(s): ${v.map((c) => c.displayName).join(', ')}`);
    channelId = v[0]?.id ?? '';
  } else {
    console.log(`L3 FAIL ${r.status} — ${why(r.body)}\n        ${r.body}`);
  }
}

// ---- layer 4: READ channel messages ----------------------------------------------------
if (teamId && channelId) {
  const r = await g(`/teams/${teamId}/channels/${channelId}/messages?$top=3`);
  if (r.ok) {
    const v = (r.json as { value?: Array<{ id: string }> }).value ?? [];
    console.log(`L4 PASS read ${v.length} channel message(s)`);
  } else {
    console.log(`L4 FAIL ${r.status} — ${why(r.body)}\n        ${r.body}`);
  }
}

// ---- layer 5/6: chats ------------------------------------------------------------------
{
  const r = await g(`/users/${encodeURIComponent(USER)}/chats?$top=5`);
  if (r.ok) {
    const v = (r.json as { value?: Array<{ id: string; chatType?: string }> }).value ?? [];
    console.log(`L5 PASS ${v.length} chat(s) for ${USER}`);
    if (v[0]) {
      const m = await g(`/chats/${v[0].id}/messages?$top=3`);
      console.log(
        m.ok
          ? `L6 PASS read ${((m.json as { value?: unknown[] }).value ?? []).length} chat message(s)`
          : `L6 FAIL ${m.status} — ${why(m.body)}\n        ${m.body}`,
      );
    }
  } else {
    console.log(`L5 FAIL ${r.status} — ${why(r.body)}\n        ${r.body}`);
  }
}

// ---- layer 7: WRITE, the reason this spike exists --------------------------------------
if (teamId && channelId) {
  const res = await fetch(`${GRAPH}/teams/${teamId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: { contentType: 'text', content: 'CSGE probe — app-only channel post test. Safe to delete.' },
    }),
  });
  const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
  if (res.ok) {
    console.log(`\nL7 PASS app-only CAN post to a channel. keep-Teams is read AND write.`);
  } else {
    console.log(`\nL7 FAIL ${res.status} — ${why(body)}\n        ${body}`);
    console.log('        If this is a permission/unsupported error, app-only cannot post to');
    console.log('        channels and the keep-Teams path must be described as READ-ONLY.');
  }
} else {
  console.log('\nL7 SKIP no team/channel discovered to test against.');
}
process.exit(0);
