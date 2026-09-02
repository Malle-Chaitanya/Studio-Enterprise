/** Does the Reasoning Engine query API carry per-request auth/identity? */
const r = await fetch('https://aiplatform.googleapis.com/$discovery/rest?version=v1beta1');
const d = await r.json() as { schemas?: Record<string, { properties?: Record<string, { description?: string; type?: string; $ref?: string }> }> };
const S = d.schemas ?? {};
for (const n of Object.keys(S)) {
  if (!/QueryReasoningEngine|StreamQueryReasoningEngine/i.test(n)) continue;
  console.log(`== ${n} ==`);
  for (const [k, v] of Object.entries(S[n].properties ?? {})) {
    console.log(`  ${k}: ${v.type ?? v.$ref ?? '?'} — ${(v.description ?? '').slice(0, 220)}`);
  }
}
