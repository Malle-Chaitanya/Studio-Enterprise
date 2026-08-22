import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT='studio-enterprise-migration', GRAPH='https://graph.microsoft.com/v1.0';
const admin=await getSaToken();
async function sec(n:string){const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${n}/versions/latest:access`,{headers:{Authorization:`Bearer ${admin}`}});const j=await r.json() as {payload?:{data?:string}};return Buffer.from(j.payload?.data??'','base64').toString('utf8').trim();}
const t=await sec('studio-enterprise-ms-graph-tenant-id'),ci=await sec('studio-enterprise-ms-graph-client-id'),cs=await sec('studio-enterprise-ms-graph-client-secret');
const tr=await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:ci,client_secret:cs,scope:'https://graph.microsoft.com/.default'})});
const tok=(await tr.json() as {access_token:string}).access_token;
const H={Authorization:`Bearer ${tok}`};
const short=(s:string)=>s.replace(/\s+/g,' ').slice(0,220);

// find a user WITH chats
const us=await (await fetch(`${GRAPH}/users?$select=userPrincipalName,assignedLicenses&$top=25`,{headers:H})).json() as {value?:Array<{userPrincipalName:string;assignedLicenses?:unknown[]}>};
const licensed=(us.value??[]).filter(u=>(u.assignedLicenses?.length??0)>0);
let chatUser='', chatId='';
for (const u of licensed) {
  const r=await fetch(`${GRAPH}/users/${encodeURIComponent(u.userPrincipalName)}/chats?$top=5`,{headers:H});
  if(!r.ok) continue;
  const v=(await r.json() as {value?:Array<{id:string}>}).value??[];
  if(v.length){ chatUser=u.userPrincipalName; chatId=v[0].id; break; }
}
console.log(`chat user: ${chatUser||'(none of '+licensed.length+' licensed users has chats)'}`);

if (chatId) {
  const rd=await fetch(`${GRAPH}/chats/${chatId}/messages?$top=3`,{headers:H});
  console.log(rd.ok?`L6 PASS chat read: ${((await rd.json() as {value?:unknown[]}).value??[]).length} msg`:`L6 FAIL ${rd.status} ${short(await rd.text())}`);
  const wr=await fetch(`${GRAPH}/chats/${chatId}/messages`,{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({body:{contentType:'text',content:'CSGE probe — app-only chat send test.'}})});
  console.log(wr.ok?'L8 PASS app-only CAN send a chat message':`L8 FAIL ${wr.status} ${short(await wr.text())}`);
}

// channel create
const gr=await (await fetch(`${GRAPH}/groups?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id&$top=1`,{headers:H})).json() as {value?:Array<{id:string}>};
const team=gr.value?.[0]?.id;
if (team) {
  const cc=await fetch(`${GRAPH}/teams/${team}/channels`,{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({displayName:`csge-probe-${Date.now()%100000}`,description:'CSGE probe. Safe to delete.',membershipType:'standard'})});
  console.log(cc.ok?'L9 PASS app-only CAN create a channel':`L9 FAIL ${cc.status} ${short(await cc.text())}`);
}
process.exit(0);
