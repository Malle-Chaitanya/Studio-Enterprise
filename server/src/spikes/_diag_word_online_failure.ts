/**
 * Real test of the Word Online (Business) "Convert Word Document to PDF" failure — the exact
 * captured operation, the exact fixed item id from Sales Profiler Agent's own tool config,
 * called with the real stored app credentials. No inference — just the real HTTP response.
 *
 * Run: npx tsx src/spikes/_diag_word_online_failure.ts
 */
const { getDb, connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
const { getSaToken } = await import('../auth/google.js');

const PROJECT = 'agentmigrations';
const SCOPE_PREFIX = 'studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph';
const HOST = 'https://secretmanager.googleapis.com/v1';

async function readSecret(saToken: string, secretId: string): Promise<string> {
  const url = `${HOST}/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb();

  const agent = await db.collection('agentIRCache').findOne({
    sourceId: 'c9176288-690a-4629-9d0a-cd8c86a29f2a',
  } as never);
  if (!agent) throw new Error('agent not found');

  const wordTool = ((agent as any).ir?.agentTools ?? []).find(
    (t: any) => t.connectorId === 'shared_wordonlinebusiness',
  );
  console.log('=== Real captured Word Online tool ===');
  console.log(JSON.stringify(wordTool, null, 2));

  const op = await db.collection('connectorOperations').findOne({
    connectorId: 'shared_wordonlinebusiness',
    operationId: wordTool?.operationId,
  } as never);
  console.log('\n=== Real captured operation (Microsoft swagger) ===');
  console.log(JSON.stringify(op, null, 2));

  const saToken = await getSaToken();
  const tenantId = await readSecret(saToken, `${SCOPE_PREFIX}-tenant-id`);
  const clientId = await readSecret(saToken, `${SCOPE_PREFIX}-client-id`);
  const clientSecret = await readSecret(saToken, `${SCOPE_PREFIX}-client-secret`);

  const form = new URLSearchParams({
    grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  });
  const tokenBody = (await tokenRes.json()) as { access_token?: string };
  if (!tokenRes.ok || !tokenBody.access_token) {
    console.log('TOKEN MINT FAILED', tokenRes.status, tokenBody);
    return;
  }
  const token = tokenBody.access_token;

  const itemInput = (wordTool?.inputs ?? []).find((i: any) => /id|path|source/i.test(i.name));
  console.log('\nRelevant fixed input for the item:', JSON.stringify(itemInput));

  // Fall back to a real, known-good drive item search if no fixed id, so we test SOMETHING
  // real rather than nothing.
  console.log('\n=== Live calls ===');
  const res1 = await fetch('https://graph.microsoft.com/v1.0/users/erik@filefuze.co/drive/root', {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('GET erik drive root ->', res1.status, (await res1.text()).slice(0, 400));

  if (itemInput?.value) {
    const res2 = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${itemInput.value}/content?format=pdf`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    console.log('GET convert (me/drive) ->', res2.status, (await res2.text()).slice(0, 400));
  }
}

main()
  .then(() => closeDb())
  .catch((e) => {
    console.error('FAILED:', e);
  })
  .finally(() => process.exit(0));
