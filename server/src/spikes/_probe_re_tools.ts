/** What tools does the deployed Reasoning Engine actually expose? */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const RE = process.env.RE || 'projects/505103737920/locations/us-central1/reasoningEngines/4850250904596643840';
const token = await getSaToken(process.env.SUBJECT || 'admin@migrationn.com');
const r = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const j = await r.json() as any;
console.log(`HTTP ${r.status} state=${j.error ? JSON.stringify(j.error).slice(0,200) : 'ok'}`);
const ops = j.spec?.classMethods ?? [];
console.log('classMethods=' + ops.map((m: any) => m.name || m.api_mode).join(', '));
console.log('updateTime=' + j.updateTime);
process.exit(0);
