/**
 * Live probe for the 3 read-only Teams tools added 2026-08-24 (teams_get_team,
 * teams_get_channel, teams_list_associated_teams). All three were documented as
 * "buildable per Microsoft Graph's docs" but NOT measured against a live tenant — this
 * spike closes that gap for the read-only subset. The 4 new write tools (update/archive
 * channel, create chat, create team) are deliberately NOT probed here: each would create
 * or mutate real state in the tenant, which this spike must not do without a separate,
 * explicit decision.
 *
 * Read-only, creates nothing.
 *
 *   cd server && npx tsx src/spikes/_diag_teams_new_reads_probe.ts [userEmail]
 */
import 'dotenv/config';

const TENANT = process.env.MS_GRAPH_TENANT_ID ?? '';
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET ?? '';
const USER = process.argv[2] || 'erik@filefuze.co';
const GRAPH = 'https://graph.microsoft.com/v1.0';

if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET in server/.env');
  process.exit(1);
}

const tokRes = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  }),
});
const tok = (await tokRes.json()) as { access_token?: string; error_description?: string };
if (!tok.access_token) {
  console.log(`TOKEN FAIL: ${tok.error_description?.slice(0, 200)}`);
  process.exit(0);
}
const H = { Authorization: `Bearer ${tok.access_token}` };
console.log('token minted');

async function g(path: string): Promise<{ ok: boolean; status: number; body: string; json: unknown }> {
  const res = await fetch(`${GRAPH}${path}`, { headers: H });
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, body: body.replace(/\s+/g, ' ').slice(0, 300), json };
}

// ---- discover a team + channel to probe against, exactly as _diag_teams_graph_probe.ts does
let teamId = '';
let teamName = '';
{
  const r = await g(`/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName&$top=1`);
  if (r.ok) {
    const v = (r.json as { value?: Array<{ id: string; displayName: string }> }).value ?? [];
    teamId = v[0]?.id ?? '';
    teamName = v[0]?.displayName ?? '';
    console.log(`discovered team: ${teamName || '(none)'} (${teamId || 'n/a'})`);
  } else {
    console.log(`team discovery FAIL ${r.status} — ${r.body}`);
  }
}

let channelId = '';
let channelName = '';
if (teamId) {
  const r = await g(`/teams/${teamId}/channels`);
  if (r.ok) {
    const v = (r.json as { value?: Array<{ id: string; displayName: string }> }).value ?? [];
    channelId = v[0]?.id ?? '';
    channelName = v[0]?.displayName ?? '';
    console.log(`discovered channel: ${channelName || '(none)'} (${channelId || 'n/a'})`);
  } else {
    console.log(`channel discovery FAIL ${r.status} — ${r.body}`);
  }
}

// ---- teams_get_team ---------------------------------------------------------------------
if (teamId) {
  const r = await g(`/teams/${teamId}`);
  const t = r.json as { displayName?: string; description?: string; visibility?: string };
  console.log(
    r.ok
      ? `teams_get_team        PASS  name="${t.displayName}" visibility=${t.visibility}`
      : `teams_get_team        FAIL  ${r.status} — ${r.body}`,
  );
} else {
  console.log('teams_get_team        SKIP  no team discovered');
}

// ---- teams_get_channel ------------------------------------------------------------------
if (teamId && channelId) {
  const r = await g(`/teams/${teamId}/channels/${channelId}`);
  const c = r.json as { displayName?: string; membershipType?: string };
  console.log(
    r.ok
      ? `teams_get_channel     PASS  name="${c.displayName}" membershipType=${c.membershipType}`
      : `teams_get_channel     FAIL  ${r.status} — ${r.body}`,
  );
} else {
  console.log('teams_get_channel     SKIP  no team/channel discovered');
}

// ---- teams_list_associated_teams ---------------------------------------------------------
// The Copilot swagger's /me/teamwork/associatedTeams is claimed unusable app-only; the tool
// calls /users/{id}/... instead. This is the specific claim being tested here.
{
  const r = await g(`/users/${encodeURIComponent(USER)}/teamwork/associatedTeams`);
  if (r.ok) {
    const v = (r.json as { value?: Array<{ displayName?: string }> }).value ?? [];
    console.log(`teams_list_associated_teams PASS  ${v.length} associated team(s) for ${USER}: ${v.map((x) => x.displayName).join(', ') || '(none)'}`);
  } else {
    console.log(`teams_list_associated_teams FAIL  ${r.status} — ${r.body}`);
  }
}
process.exit(0);
