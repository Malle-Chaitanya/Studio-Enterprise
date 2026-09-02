/** What shape does a Discovery Engine Authorization take, and can agents reference one? */
const r = await fetch('https://discoveryengine.googleapis.com/$discovery/rest?version=v1alpha');
const d = await r.json() as { schemas?: Record<string, { properties?: Record<string, { description?: string; type?: string; $ref?: string }> }> };
const names = Object.keys(d.schemas ?? {}).filter((n) => /Authorization/i.test(n));
console.log('Authorization schemas:', names.join(', ') || '(none)');
for (const n of names.slice(0, 4)) {
  const props = d.schemas![n].properties ?? {};
  console.log(`\n== ${n} ==`);
  for (const [k, v] of Object.entries(props)) {
    console.log(`  ${k}: ${v.type ?? v.$ref ?? '?'} — ${(v.description ?? '').slice(0, 110)}`);
  }
}
// Which agent/engine fields reference authorizations?
for (const [n, s] of Object.entries(d.schemas ?? {})) {
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    if (/authorization/i.test(k)) console.log(`REF ${n}.${k}: ${(v.description ?? '').slice(0, 130)}`);
  }
}
