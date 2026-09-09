/** Can app-only Graph create a new 1:1 chat between Alex@qatestagent.com and
 *  erik@filefuze.co? Needed to migrate Postoteams if no chat already exists.
 *  npx tsx src/spikes/_diag_try_create_erik_chat.ts */
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

async function userId(upn: string) {
  const r = await fetch(`${GRAPH}/users/${encodeURIComponent(upn)}?$select=id,displayName`, { headers: H });
  const j = (await r.json()) as { id?: string; displayName?: string; error?: unknown };
  console.log(`  ${upn} -> ${r.status} ${j.id ?? JSON.stringify(j.error).slice(0, 150)}`);
  return j.id;
}
console.log('Resolving user ids:');
const alexId = await userId('Alex@qatestagent.com');
const erikId = await userId('erik@filefuze.co');

if (!alexId || !erikId) {
  console.log('Cannot proceed: missing a user id.');
  process.exit(0);
}

const body = {
  chatType: 'oneOnOne',
  members: [
    { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${alexId}')` },
    { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${erikId}')` },
  ],
};
const createRes = await fetch(`${GRAPH}/chats`, { method: 'POST', headers: H, body: JSON.stringify(body) });
console.log('\nCreate chat status:', createRes.status);
const text = await createRes.text();
console.log(text.slice(0, 1500));
process.exit(0);
