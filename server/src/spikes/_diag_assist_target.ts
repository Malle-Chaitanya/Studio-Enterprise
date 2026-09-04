import { getSaToken } from '../auth/google.js';
const P='505103737920', E='gemini-enterprise-app_1787446545912';
const base=`https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines/${E}/assistants/default_assistant`;
const token=await getSaToken('admin@migrationn.com');
const AGENTS: [string,string][] = [
  ['Migrate Advisor', '4839019307637799308'],
  ['WorkMate',        '13300623640757970256'],
];
const q='Who are you? State your exact agent name and nothing else.';

/** Walk the streamed chunk array and concatenate every content.text. */
function collect(node: unknown, out: string[]): void {
  if (Array.isArray(node)) { for (const n of node) collect(n, out); return; }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.text === 'string') out.push(o.text);
    for (const v of Object.values(o)) collect(v, out);
  }
}

async function ask(body: unknown): Promise<string> {
  try {
    const res = await fetch(`${base}:streamAssist`, {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) return `HTTP ${res.status}: ${raw.replace(/\s+/g,' ').slice(0,160)}`;
    const out: string[] = [];
    collect(JSON.parse(raw), out);
    return out.join('').replace(/\s+/g,' ').trim().slice(0,180) || '(200, no answer text)';
  } catch (e) { return `THREW ${(e as Error).message}`; }
}

console.log('BASELINE (no agent):');
console.log('   ', await ask({ query:{ text:q } }));
for (const [name,id] of AGENTS) {
  console.log(`\n${name}:`);
  console.log('   ', await ask({ query:{ text:q }, agentsConfig:{ agent: `${base}/agents/${id}` } }));
}
console.log('\nBOGUS agent id (must error if targeting is real):');
console.log('   ', await ask({ query:{ text:q }, agentsConfig:{ agent: `${base}/agents/000000000000000` } }));
