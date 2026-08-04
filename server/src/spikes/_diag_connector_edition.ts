/** Confirms whether Discovery Engine's `:setUpDataConnector` (native SharePoint
 *  connector) is reachable on a given Gemini Enterprise project/edition — resolves
 *  the open "is the connector API edition-gated (Standard/Plus expose a dataConnector
 *  REST API; Business's documented path is Console-UI-only)?" question from
 *  docs/knowledge-sources-migration-playbook.md §12 instead of assuming an answer.
 *
 *  Uses throwaway Entra credentials on purpose — Google's own project/edition
 *  permission check happens before Microsoft ever validates them, so a 403/404
 *  here reflects Gemini-side access, not a bad Entra app. Run against BOTH test
 *  projects and compare:
 *   npx tsx src/spikes/_diag_connector_edition.ts 231705905417   (Standard: studio-enterprise-migration)
 *   npx tsx src/spikes/_diag_connector_edition.ts 860501065102   (Business: the-dispatch-0vzc3)
 *
 *  Also useful for the second open question — whether `instance_uri` is really
 *  per-site (see geminiConnector.ts's doc comment) — pass a real site URL as the
 *  second arg and, once this run's connector reaches `done` (poll separately via
 *  getConnectorOperation / the /sharepoint-connector/status route), check in Cloud
 *  Console whether a DIFFERENT site under the same tenant is also queryable through
 *  it, or only the one URL given here.
 *   npx tsx src/spikes/_diag_connector_edition.ts <project> <siteUrl> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { setUpSharePointConnector } from '../services/geminiConnector.js';

const [PROJECT, SITE_URL] = process.argv.slice(2);

async function main() {
  if (!PROJECT) throw new Error('usage: _diag_connector_edition.ts <project> [siteUrl]');
  await connectMongo();
  const s = (await getDb()
    .collection('migrationSessions')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  const collectionId = `zz-diag-connector-${Date.now().toString(36)}`;
  const result = await setUpSharePointConnector(PROJECT, 'global', token, collectionId, 'ZZ Diagnostic Connector Test', {
    clientId: 'diagnostic-placeholder-client-id',
    clientSecret: 'diagnostic-placeholder-secret',
    tenantId: 'diagnostic-placeholder-tenant',
    instanceUri: SITE_URL || 'https://contoso.sharepoint.com/sites/diagnostic-test',
  });

  console.log(`project=${PROJECT}`);
  console.log(`collectionId=${collectionId}`);
  console.log(`started=${result.started}`);
  if (result.operationName) console.log(`operationName=${result.operationName}`);
  if (result.error) console.log(`error=${result.error}`);
  console.log(
    result.started
      ? '\n>>> API accepted the call — this project/edition supports the dataConnector API surface.\n' +
          '    Credential validation against Microsoft happens asynchronously inside the LRO — that\n' +
          '    failing later (bad placeholder creds) is expected and does NOT indicate edition gating.\n' +
          '    Clean up in Cloud Console (Search > Data > delete this collection) once done inspecting.'
      : '\n>>> API rejected the call before any Microsoft-side check could even run.\n' +
          '    A 403 PERMISSION_DENIED / 404 here (not a validation error about the placeholder creds)\n' +
          '    is the signal that confirms edition gating for this project.',
  );
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
