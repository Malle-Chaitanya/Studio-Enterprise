/** Does the local-part fallback find the right mailbox? ben@migrationn.com -> ben@filefuze.co */
import { clientCredsToken } from '../auth/microsoft.js';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', 'https://graph.microsoft.com');
const G = 'https://graph.microsoft.com/v1.0';
for (const caller of ['ben@migrationn.com', 'alex@migrationn.com', 'amelia1@migrationn.com', 'nobody@migrationn.com']) {
  const local = caller.split('@')[0];
  const f = encodeURIComponent(`startswith(mail,'${local}@')`);
  const r = await fetch(`${G}/users?$select=mail&$top=3&$count=true&$filter=${f}`,
    { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
  const rows = r.ok ? ((await r.json()) as any).value.filter((x: any) => x.mail) : [];
  console.log(`${caller.padEnd(26)} -> ${rows.length === 1 ? rows[0].mail : rows.length === 0 ? 'NO MATCH (refuses)' : 'AMBIGUOUS: ' + rows.map((x: any) => x.mail).join(', ')}`);
}
