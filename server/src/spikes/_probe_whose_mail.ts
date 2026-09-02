/** Which mailbox contains the "groupo" subjects the agent returned for BOTH callers? */
import { clientCredsToken } from '../auth/microsoft.js';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', 'https://graph.microsoft.com');
const G = 'https://graph.microsoft.com/v1.0';
for (const who of ['erik@filefuze.co', 'ben@filefuze.co', 'ron@filefuze.co', 'admin@migrationn.com']) {
  const r = await fetch(`${G}/users/${encodeURIComponent(who)}/messages?$select=subject&$top=3`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { console.log(`${who.padEnd(24)} ${r.status}`); continue; }
  const subs = ((await r.json()) as any).value.map((m: any) => (m.subject || '(none)').slice(0, 46));
  console.log(`${who.padEnd(24)} ${subs.join(' | ')}`);
}
