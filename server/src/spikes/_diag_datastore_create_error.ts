import 'dotenv/config';
import { getSaToken, discoverGeminiProject } from '../auth/google.js';

async function main() {
  const saToken = await getSaToken();
  const project = await discoverGeminiProject(saToken);
  const dataStoreId = '124794af-3b8f-f111-b8da-0022480b1f83-file-slack-to-teams-migrat';
  const res = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores?dataStoreId=${encodeURIComponent(dataStoreId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Slack to Teams- Migration Guide.pdf (ADK file grounding — recovery)',
        industryVertical: 'GENERIC',
        solutionTypes: ['SOLUTION_TYPE_SEARCH'],
        contentConfig: 'CONTENT_REQUIRED',
      }),
    },
  );
  console.log('status:', res.status);
  console.log('body:', await res.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
