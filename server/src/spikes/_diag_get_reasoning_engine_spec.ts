import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const RE = process.argv[2];
async function main() {
  const token = await getSaToken();
  const url = `https://us-central1-aiplatform.googleapis.com/v1/${RE}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log('status:', r.status);
  console.log(JSON.stringify(await r.json(), null, 2).slice(0, 6000));
}
main().catch((e) => console.error(e.message));
