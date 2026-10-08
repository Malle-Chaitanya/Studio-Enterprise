/** Which connector each Deal Desk 3 invoker tool uses, and which registry bucket it lands in. */
import { clientCredsToken } from '../auth/microsoft.js';
import { connectionAuthModeFrom } from '../services/connectorRef.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const BOT = '91206676-c49f-f111-aaad-0022480b169d';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const r = await fetch(
  `${ORG}/api/data/v9.2/botcomponents?$select=name,data&$filter=statecode eq 0 and _parentbotid_value eq ${BOT} and componenttype eq 9`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
);
for (const c of (JSON.parse(await r.text()).value ?? []) as any[]) {
  const data = `${c.data ?? ''}`;
  const mode = connectionAuthModeFrom(data);
  if (mode !== 'invoker') continue;
  const conn = [...new Set(data.match(/shared_[a-zA-Z0-9_]+/g) ?? [])];
  const buckets = conn.map((id) => {
    const e = REGISTRY_BY_ID.get(id);
    if (!e) return `${id}=NOT_IN_REGISTRY`;
    return `${id}=${e.impersonation ? 'impersonation' : e.userAuth ? 'userAuth' : 'BLOCKED'}`;
  });
  console.log(`${String(c.name).slice(0, 34).padEnd(36)} ${buckets.join('  ') || '(no connector ref)'}`);
}
