/** Does Alex@qatestagent.com (the proven shared_teams impersonation identity) already
 *  have a 1:1 chat with erik@filefuze.co? Needed to migrate Postoteams, which posts into
 *  the bot's existing chat with erik. Read-only.
 *  npx tsx src/spikes/_diag_find_erik_chat.ts */
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
const H = { Authorization: `Bearer ${tok}` };
const GRAPH = 'https://graph.microsoft.com/v1.0';

const user = 'Alex@qatestagent.com';
const chatsRes = await fetch(`${GRAPH}/users/${encodeURIComponent(user)}/chats?$expand=members&$top=50`, { headers: H });
console.log('chats list status:', chatsRes.status);
const chatsJson = (await chatsRes.json()) as { value?: Array<{ id: string; topic?: string; chatType?: string; members?: Array<{ email?: string; displayName?: string }> }> };
const chats = chatsJson.value ?? [];
console.log(`${user} has ${chats.length} chat(s)`);
for (const c of chats) {
  const emails = (c.members ?? []).map((m) => m.email).filter(Boolean);
  console.log(`  chat ${c.id} type=${c.chatType} topic=${c.topic ?? '-'} members=${emails.join(', ')}`);
}
const withErik = chats.find((c) => (c.members ?? []).some((m) => (m.email ?? '').toLowerCase() === 'erik@filefuze.co'));
console.log(`\nChat with erik@filefuze.co found: ${withErik ? withErik.id : 'NONE'}`);
process.exit(0);
