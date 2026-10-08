import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const token = await getSaToken();
const r = await fetch('https://cloudbilling.googleapis.com/v1/services?pageSize=500', {
  headers: { Authorization: `Bearer ${token}` },
});
const t = await r.text();
console.log(`services -> HTTP ${r.status}`);
if (!r.ok) { console.log(t.replace(/\s+/g, ' ').slice(0, 300)); process.exit(1); }
const all = ((JSON.parse(t) as { services?: any[] }).services ?? []);
console.log(`total services: ${all.length}`);
for (const s of all.filter((x) => /vertex|ai platform|machine learning/i.test(x.displayName ?? ''))) {
  console.log(`  ${s.name}  ${s.displayName}`);
}
process.exit(0);
