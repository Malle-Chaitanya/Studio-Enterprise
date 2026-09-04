/** Two callers, two mailboxes, different mail — the per-user claim, with real data. */
import { clientCredsToken } from '../auth/microsoft.js';
const TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const token = await clientCredsToken(TENANT, 'https://graph.microsoft.com');
const G = 'https://graph.microsoft.com/v1.0';
const get = async (p: string) => {
  // endsWith on mail is an "advanced query" — Graph rejects it without this header.
  const r = await fetch(`${G}${p}`, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
  return { ok: r.ok, status: r.status, body: await r.text() };
};
const u = await get("/users?$select=mail,displayName&$filter=endswith(mail,'filefuze.co')&$count=true&$top=25");
if (!u.ok) { console.log('ERR', u.status, u.body.slice(0, 200)); process.exit(1); }
const people = (JSON.parse(u.body).value ?? []).filter((x: any) => x.mail);
console.log(`filefuze.co mailboxes: ${people.length}\n`);
for (const p of people.slice(0, 6)) {
  const r = await get(`/users/${encodeURIComponent(p.mail)}/messages?$select=subject&$top=3`);
  if (!r.ok) { console.log(`${p.mail.padEnd(30)} ${r.status}`); continue; }
  const subs = ((JSON.parse(r.body).value ?? []) as any[]).map((m) => (m.subject || '(none)').slice(0, 34));
  console.log(`${p.mail.padEnd(30)} ${subs.length} msg  ${subs.join(' | ')}`);
}
