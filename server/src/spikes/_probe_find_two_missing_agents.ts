/**
 * One-off lookup: find "Work Intelligence Network Agent" and "Credit Amendment workflow
 * agent" (or close name matches) across the accessible test-tenant environments and dump
 * their extracted IR. Throwaway — not app code.
 */
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENVS = [
  { name: 'CloudFuze Agent Migration Hub', url: 'https://org32322095.crm.dynamics.com' },
  { name: 'filefuze (default)', url: 'https://orga243378d.crm.dynamics.com' },
];
const NEEDLES = ['work intelligence', 'credit amendment'];

async function main() {
  for (const env of ENVS) {
    const token = await clientCredsToken(TENANT_ID, env.url);
    const bots = await listBots(env.url, token);
    console.log(`\n=== ${env.name} (${bots.length} bots) ===`);
    for (const b of bots) {
      const lower = b.name.toLowerCase();
      if (NEEDLES.some((n) => lower.includes(n.split(' ')[0]) || lower.includes(n))) {
        console.log(`CANDIDATE: "${b.name}" (${b.botid})`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
