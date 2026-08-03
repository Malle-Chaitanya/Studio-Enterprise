/** Check whether the Dialogflow API (and related) are ENABLED on the project. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT] = process.argv.slice(2);
const SERVICES = ['dialogflow.googleapis.com', 'discoveryengine.googleapis.com', 'aiplatform.googleapis.com'];

async function main() {
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}` };
  for (const svc of SERVICES) {
    const r = await fetch(`https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/${svc}`, { headers: h });
    const j = (await r.json()) as { state?: string; error?: { message?: string } };
    console.log(`${svc.padEnd(32)} -> ${r.status}  state=${j.state ?? j.error?.message ?? '?'}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
