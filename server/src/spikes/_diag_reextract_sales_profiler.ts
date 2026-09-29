/**
 * Live re-extraction of "Sales Profiler Agent" — our cached capture (2026-09-21) shows
 * zero connector tools, but the real Copilot Studio UI (screenshot evidence) shows 14+
 * connector tools, several modified within the last hour. Re-run the REAL extraction
 * function against the REAL Dataverse environment right now to find out whether this is
 * a staleness issue (fresh capture picks them up) or a real extraction bug (still zero).
 *
 * Run: npx tsx src/spikes/_diag_reextract_sales_profiler.ts
 */
const { clientCredsToken } = await import('../auth/microsoft.js');
const { extractAgent } = await import('../services/dataverse.js');

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const BOTID = 'c9176288-690a-4629-9d0a-cd8c86a29f2a';

async function main() {
  console.log('Minting a fresh Dataverse token...');
  const token = await clientCredsToken(TENANT_ID, ENV_URL);

  console.log('Re-extracting "Sales Profiler Agent" live from Dataverse...\n');
  const ir = await extractAgent(ENV_URL, token, { botid: BOTID, name: 'Sales Profiler Agent' });

  console.log('agentTools length (fresh):', (ir.agentTools ?? []).length);
  console.log('isManaged:', ir.isManaged);
  console.log('unmapped:', ir.unmapped.slice(0, 5));
  console.log('\nFirst 20 agentTools:');
  for (const t of (ir.agentTools ?? []).slice(0, 20)) {
    console.log(`  kind=${t.kind} connectorId=${t.connectorId ?? '-'} operationId=${t.operationId ?? '-'} name="${t.name}"`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
