import { getSaToken } from '../auth/google.js';
const P='505103737920', E='gemini-enterprise-app_1787446545912', A='4839019307637799308';
const token=await getSaToken('admin@migrationn.com');
const root=(v:string)=>`https://discoveryengine.googleapis.com/${v}/projects/${P}/locations/global/collections/default_collection/engines/${E}/assistants/default_assistant`;
const cases: [string,string,unknown][] = [
  ['v1alpha :assist         ', `${root('v1alpha')}:assist`, {query:{text:'hi'}}],
  ['v1alpha :streamAssist   ', `${root('v1alpha')}:streamAssist`, {query:{text:'hi'}}],
  ['v1beta  :assist         ', `${root('v1beta')}:assist`, {query:{text:'hi'}}],
  ['v1      :assist         ', `${root('v1')}:assist`, {query:{text:'hi'}}],
  ['v1alpha agents/<id>:assist', `${root('v1alpha')}/agents/${A}:assist`, {query:{text:'hi'}}],
];
for (const [label,url,body] of cases) {
  const res=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const t=await res.text();
  console.log(`${label}  HTTP ${res.status}  ${t.replace(/\s+/g,' ').slice(0,180)}`);
}
