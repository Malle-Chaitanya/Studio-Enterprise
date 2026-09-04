/** Can the app read a NAMED user's mailbox? That is per-user Outlook, without consent. */
import { clientCredsToken } from '../auth/microsoft.js';
const TENANT = process.env.MS_TENANT_ID || '807d6772-847c-40e2-9bec-e2c930b3a42e';
const token = await clientCredsToken(TENANT, 'https://graph.microsoft.com');
const G = 'https://graph.microsoft.com/v1.0';
const get = async (p: string) => {
  const r = await fetch(`${G}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return { ok: r.ok, status: r.status, body: await r.text() };
};

const users = await get('/users?$select=mail,userPrincipalName,displayName,accountEnabled&$top=20');
if (!users.ok) { console.log('list users failed:', users.status, users.body.slice(0, 300)); process.exit(1); }
const all = (JSON.parse(users.body).value ?? []) as Array<{ mail?: string; userPrincipalName: string; displayName: string; accountEnabled: boolean }>;
const mailboxes = all.filter((u) => u.mail && u.accountEnabled).slice(0, 6);
console.log(`users with a mail address: ${mailboxes.length}\n`);

for (const u of mailboxes) {
  const r = await get(`/users/${encodeURIComponent(u.mail!)}/messages?$select=subject,receivedDateTime&$top=3`);
  if (!r.ok) {
    const msg = (() => { try { return JSON.parse(r.body).error?.message ?? ''; } catch { return r.body.slice(0, 120); } })();
    console.log(`${u.mail!.padEnd(34)} ${r.status}  ${msg.slice(0, 110)}`);
    continue;
  }
  const msgs = (JSON.parse(r.body).value ?? []) as Array<{ subject?: string }>;
  console.log(`${u.mail!.padEnd(34)} OK   ${msgs.length} message(s)  ${msgs.map((m) => (m.subject || '(no subject)').slice(0, 26)).join(' | ')}`);
}
