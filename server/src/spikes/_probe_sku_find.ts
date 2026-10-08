import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const token = await getSaToken();
const h = { Authorization: `Bearer ${token}` };
let pageToken = '';
const hits: { name: string; displayName: string }[] = [];
for (let page = 0; page < 20; page++) {
  const r = await fetch(
    `https://cloudbilling.googleapis.com/v1/services?pageSize=500${pageToken ? `&pageToken=${pageToken}` : ''}`,
    { headers: h },
  );
  if (!r.ok) break;
  const j = JSON.parse(await r.text()) as { services?: any[]; nextPageToken?: string };
  for (const s of j.services ?? []) {
    if (/^vertex ai$|^cloud ai$|^ai platform$/i.test(s.displayName ?? '')) {
      hits.push({ name: s.name, displayName: s.displayName });
    }
  }
  if (!j.nextPageToken) break;
  pageToken = j.nextPageToken;
}
console.log(hits.length ? hits.map((x) => `${x.name}  ${x.displayName}`).join('\n') : 'not found');
process.exit(0);
