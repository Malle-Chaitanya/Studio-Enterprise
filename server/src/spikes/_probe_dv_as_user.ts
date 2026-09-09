/** Read the credit-facility table AS a named user, via MSCRMCallerID impersonation. */
import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const api = `${ORG}/api/data/v9.2`;

async function systemUserId(email: string): Promise<string | undefined> {
  const r = await fetch(`${api}/systemusers?$select=systemuserid&$filter=internalemailaddress eq '${email}'`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  return (JSON.parse(await r.text()).value ?? [])[0]?.systemuserid;
}

for (const who of (process.env.WHO || 'erik@filefuze.co,alex@filefuze.co').split(',')) {
  const id = await systemUserId(who.trim());
  if (!id) { console.log(`${who.padEnd(20)} not a systemuser`); continue; }
  const r = await fetch(`${api}/cr88d_clientcreditfacilities?$select=cr88d_clientname&$top=3`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', MSCRMCallerID: id },
  });
  const body = await r.text();
  if (r.ok) {
    const names = (JSON.parse(body).value ?? []).map((x: { cr88d_clientname?: string }) => x.cr88d_clientname);
    console.log(`${who.padEnd(20)} ${r.status}  rows=${names.length}  ${names.join(' | ')}`);
  } else {
    const msg = (() => { try { return JSON.parse(body).error?.message ?? body; } catch { return body; } })();
    console.log(`${who.padEnd(20)} ${r.status}  ${String(msg).slice(0, 170)}`);
  }
}
