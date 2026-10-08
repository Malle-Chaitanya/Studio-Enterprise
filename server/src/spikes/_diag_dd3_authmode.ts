/** Real connectionAuthMode for Deal Desk 3's tools, via the shipped parser. */
import { clientCredsToken } from '../auth/microsoft.js';
import { connectionAuthModeFrom } from '../services/connectorRef.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const BOT = process.env.BOT || '91206676-c49f-f111-aaad-0022480b169d';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const r = await fetch(
  `${ORG}/api/data/v9.2/botcomponents?$select=name,componenttype,data&$filter=statecode eq 0 and _parentbotid_value eq ${BOT} and componenttype eq 9`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
);
for (const c of (JSON.parse(await r.text()).value ?? []) as any[]) {
  const data = `${c.data ?? ''}`;
  console.log(`${String(c.name).slice(0, 44).padEnd(46)} authMode=${connectionAuthModeFrom(data) ?? 'UNSET'}`);
}
