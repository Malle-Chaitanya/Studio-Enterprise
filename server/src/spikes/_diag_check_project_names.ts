import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function checkProject(saToken: string, projectNumber: string) {
  const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectNumber}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log(`\n>>> project ${projectNumber}`);
  console.log('status:', res.status);
  console.log(await res.text());
}

async function main() {
  const saToken = await getSaToken();
  await checkProject(saToken, '231705905417');
  await checkProject(saToken, '72860638029');
}
main().catch((e) => console.error('FAILED:', e.message));
