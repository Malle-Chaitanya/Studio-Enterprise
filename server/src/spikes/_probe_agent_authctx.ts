/** What identity/auth context does a Discovery Engine agent receive at invoke time? */
const r = await fetch('https://discoveryengine.googleapis.com/$discovery/rest?version=v1alpha');
const d = await r.json() as { schemas?: Record<string, { properties?: Record<string, { description?: string; type?: string; $ref?: string }> }> };
const S = d.schemas ?? {};

// 1. The Agent resource — how is an ADK/reasoning-engine agent declared?
for (const n of Object.keys(S)) {
  if (!/V1alphaAgent$|AgentAdk|ReasoningEngine|ManagedAgent/i.test(n)) continue;
  console.log(`\n== ${n} ==`);
  for (const [k, v] of Object.entries(S[n].properties ?? {})) {
    console.log(`  ${k}: ${v.type ?? v.$ref ?? '?'} — ${(v.description ?? '').slice(0, 130)}`);
  }
}
// 2. Anything carrying end-user identity into a request
console.log('\n== fields mentioning end user / authorization token ==');
for (const [n, s] of Object.entries(S)) {
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const t = `${k} ${v.description ?? ''}`;
    if (/end.?user|user.?id|assistant.*user|auth token|access token/i.test(t) && /Assist|Agent|Session|Answer/i.test(n)) {
      console.log(`  ${n}.${k}: ${(v.description ?? '').slice(0, 150)}`);
    }
  }
}
