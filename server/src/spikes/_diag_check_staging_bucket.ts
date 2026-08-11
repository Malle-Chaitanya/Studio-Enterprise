import 'dotenv/config';
import { getSaToken, serviceAccountEmail } from '../auth/google.js';

const PROJECT = '72860638029';
const BUCKET = `${PROJECT}-adk-staging`;

async function main() {
  const saToken = await getSaToken();
  console.log('SA:', serviceAccountEmail());

  const getRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}?projection=noAcl`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log('\nGET bucket status:', getRes.status);
  console.log((await getRes.text()).slice(0, 1000));

  // Check if the bucket exists at all (list buckets in project)
  const listRes = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${PROJECT}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log('\nLIST buckets status:', listRes.status);
  console.log((await listRes.text()).slice(0, 1500));
}
main().catch((e) => console.error('FAILED:', e.message));
