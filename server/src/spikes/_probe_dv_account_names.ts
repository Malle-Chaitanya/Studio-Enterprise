import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const r = await fetch(`${ORG}/api/data/v9.2/accounts?$select=name&$top=5`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
const j = JSON.parse(await r.text()) as { value?: { name: string }[]; error?: { message?: string } };
if (!r.ok) { console.log('status', r.status, j.error?.message); }
for (const a of j.value ?? []) console.log(' -', a.name);
