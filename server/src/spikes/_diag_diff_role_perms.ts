import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function getPerms(token: string, role: string): Promise<Set<string>> {
  const res = await fetch(`https://iam.googleapis.com/v1/${role}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json() as { includedPermissions?: string[] };
  return new Set(body.includedPermissions ?? []);
}

async function main() {
  const token = await getSaToken(undefined);
  const pairs: [string, string][] = [
    ['roles/discoveryengine.editor', 'roles/discoveryengine.agentspaceEditor'],
    ['roles/discoveryengine.user', 'roles/discoveryengine.agentspaceUser'],
    ['roles/discoveryengine.viewer', 'roles/discoveryengine.agentspaceUser'],
  ];
  for (const [a, b] of pairs) {
    const [pa, pb] = await Promise.all([getPerms(token, a), getPerms(token, b)]);
    const onlyA = [...pa].filter((x) => !pb.has(x));
    const onlyB = [...pb].filter((x) => !pa.has(x));
    console.log(`\n=== ${a} (${pa.size}) vs ${b} (${pb.size}) ===`);
    console.log('only in first:', onlyA);
    console.log('only in second:', onlyB);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
