/** Post a real message into the newly created Alex<->erik chat, app-only. Confirms the
 *  full write path Postoteams needs before building the Application Integration flow.
 *  npx tsx src/spikes/_diag_try_post_erik_chat.ts */
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

const CHAT_ID = '19:8c9ea578-b494-42e7-9669-203c1cb5098e_df3e973a-171f-4666-8707-d5eaf1de0916@unq.gbl.spaces';
const text = 'CSGE migration probe: Postoteams equivalence — real message via app-only Graph.';
const body = { body: { contentType: 'html', content: `<p>Here's the amendment summary:</p><br><br><p>${text}</p>` } };

const res = await fetch(`${GRAPH}/chats/${CHAT_ID}/messages`, { method: 'POST', headers: H, body: JSON.stringify(body) });
console.log('Post status:', res.status);
const json = (await res.json()) as { id?: string; webUrl?: string; error?: unknown };
console.log(JSON.stringify(json, null, 2).slice(0, 1000));
process.exit(0);
