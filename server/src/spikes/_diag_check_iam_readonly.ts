import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const SERVICE_AGENT = 'serviceAccount:service-231705905417@gcp-sa-aiplatform-re.iam.gserviceaccount.com';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log('status:', res.status);
  const policy = (await res.json()) as { bindings?: { role: string; members: string[] }[] };
  const relevant = (policy.bindings ?? []).filter((b) => b.members.includes(SERVICE_AGENT));
  console.log(`Roles currently held by ${SERVICE_AGENT}:`, JSON.stringify(relevant.map((b) => b.role), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
