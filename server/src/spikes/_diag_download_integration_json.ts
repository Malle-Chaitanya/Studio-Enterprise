import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'DraftFollowUpEmail';
const base = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}`;

const listRes = await fetch(`${base}/versions`, { headers: { Authorization: `Bearer ${saToken}` } });
const listJson = await listRes.json();
console.log('LIST status:', listRes.status);
console.log(JSON.stringify(listJson, null, 2).slice(0, 2000));

const versions = listJson.integrationVersions ?? [];
if (versions.length) {
  const versionName = versions[0].name; // full resource name, includes version id
  const downloadRes = await fetch(`https://${LOCATION}-integrations.googleapis.com/v1/${versionName}:download`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  const downloadText = await downloadRes.text();
  console.log('\nDOWNLOAD status:', downloadRes.status);
  console.log(downloadText);
}
process.exit(0);
