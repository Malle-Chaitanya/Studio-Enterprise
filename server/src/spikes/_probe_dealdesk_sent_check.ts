import { clientCredsToken } from '../auth/microsoft.js';

const TENANT = process.env.MS_TENANT_ID || '807d6772-847c-40e2-9bec-e2c930b3a42e';
const WHO = 'erik@filefuze.co';
const token = await clientCredsToken(TENANT, 'https://graph.microsoft.com');
const h = { Authorization: `Bearer ${token}` };

// Ground truth by ORDER, not by $search — $search depends on an index that lags a
// just-sent message, which is exactly the ambiguity we are trying to remove.
for (const folder of ['SentItems', 'Inbox']) {
  const url = `https://graph.microsoft.com/v1.0/users/${WHO}/mailFolders/${folder}/messages`
    + `?$select=subject,sentDateTime,from,toRecipients&$top=5&$orderby=sentDateTime desc`;
  const r = await fetch(url, { headers: h });
  const j = (await r.json()) as { value?: { subject?: string; sentDateTime?: string; from?: { emailAddress?: { address?: string } } }[]; error?: unknown };
  console.log(`--- ${folder} (${r.status})`);
  if (!r.ok) { console.log('   ', JSON.stringify(j.error).slice(0, 200)); continue; }
  for (const m of j.value ?? []) {
    console.log(`    ${String(m.sentDateTime).slice(0, 19)}  from=${m.from?.emailAddress?.address ?? '?'}  ${String(m.subject).slice(0, 60)}`);
  }
}
