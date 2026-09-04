import { getSaToken } from '../auth/google.js';
const P='505103737920', E='gemini-enterprise-app_1787446545912', A='4839019307637799308';
const token=await getSaToken('admin@migrationn.com');
const base=`https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines/${E}/assistants/default_assistant`;
const agentRes=`${base}/agents/${A}`;
const q='What can you help me with? List your capabilities.';
const cases: [string,unknown][] = [
  ['plain question, no agent', {query:{text:q}}],
  ['agentsConfig.agent',       {query:{text:q}, agentsConfig:{agent:agentRes}}],
  ['agentsSpec',               {query:{text:q}, agentsSpec:{agentSpecs:[{agent:agentRes}]}}],
  ['assistSkippingMode',       {query:{text:q}, assistSkippingMode:'REQUEST_ASSIST'}],
  ['agent+skipmode',           {query:{text:q}, assistSkippingMode:'REQUEST_ASSIST', agentsConfig:{agent:agentRes}}],
];
for (const [label,body] of cases) {
  const res=await fetch(`${base}:streamAssist`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const t=await res.text();
  console.log(`\n### ${label}  -> HTTP ${res.status}`);
  console.log('    '+t.replace(/\s+/g,' ').slice(0,320));
}
