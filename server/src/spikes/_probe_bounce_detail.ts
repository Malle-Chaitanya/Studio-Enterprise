import { clientCredsToken } from '../auth/microsoft.js';

const TENANT = process.env.MS_TENANT_ID || '807d6772-847c-40e2-9bec-e2c930b3a42e';
const WHO = 'erik@filefuze.co';
const token = await clientCredsToken(TENANT, 'https://graph.microsoft.com');
const h = { Authorization: `Bearer ${token}` };

const list = await fetch(
  `https://graph.microsoft.com/v1.0/users/${WHO}/mailFolders/Inbox/messages`
  + `?$select=id,subject,sentDateTime&$top=6&$orderby=sentDateTime desc`,
  { headers: h });
const j = (await list.json()) as { value?: { id: string; subject: string; sentDateTime: string }[]; error?: unknown };
if (!list.ok) { console.log('list failed', list.status, JSON.stringify(j.error).slice(0, 200)); process.exit(0); }
const msgs = j.value ?? [];
console.log('newest', msgs.length, 'messages');
const bounces = msgs.filter((m) => /undeliverable/i.test(m.subject ?? ''));
console.log('bounces among them:', bounces.length);
for (const m of bounces.slice(0, 2)) {
  const full = await fetch(`https://graph.microsoft.com/v1.0/users/${WHO}/messages/${m.id}?$select=subject,sentDateTime,body`, { headers: h });
  const b = (await full.json()) as { body?: { content?: string } };
  const text = String(b.body?.content ?? '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  console.log(`\n===== ${m.sentDateTime}  ${m.subject}`);
  console.log(text.slice(0, 1000));
}
