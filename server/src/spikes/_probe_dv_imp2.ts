/** Full error text + several tables, app-only vs impersonated. Read-only. */
import { clientCredsToken } from '../auth/microsoft.js';
const ORG = 'https://org32322095.crm.dynamics.com';
const TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const token = await clientCredsToken(TENANT, ORG);
const api = `${ORG}/api/data/v9.2`;
const SURAJ = 'a0a55358-d981-f111-8076-0022480405cc';

async function call(path: string, caller?: string) {
  const h: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (caller) h.MSCRMCallerID = caller;
  const r = await fetch(`${api}${path}`, { headers: h });
  return { ok: r.ok, status: r.status, body: await r.text() };
}

for (const table of ['systemusers', 'businessunits', 'accounts', 'bots']) {
  const a = await call(`/${table}?$top=50`);
  const u = await call(`/${table}?$top=50`, SURAJ);
  const n = (r: { ok: boolean; body: string }) => (r.ok ? String((JSON.parse(r.body).value ?? []).length) : 'ERR');
  console.log(`${table.padEnd(14)} app=${n(a).padEnd(4)} asSuraj=${n(u)}`);
  if (!u.ok) console.log('   ', u.body.replace(/\s+/g, ' ').slice(0, 300));
}
