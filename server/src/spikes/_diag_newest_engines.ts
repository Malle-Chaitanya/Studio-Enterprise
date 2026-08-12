import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const PROJECT='studio-enterprise-migration', LOC='us-central1';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email:k.client_email, key:k.private_key, scopes:['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const j = await (await fetch(`https://${LOC}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOC}/reasoningEngines?pageSize=200`, { headers:{Authorization:`Bearer ${access_token!}`} })).json() as any;
const all=(j.reasoningEngines??[]).map((r:any)=>({id:String(r.name).split('/').pop(),name:r.displayName,created:r.createTime}))
  .sort((a:any,b:any)=>String(b.created).localeCompare(String(a.created)));
for(const r of all.slice(0,6)) console.log(`${r.created}  ${r.id}  ${r.name}`);
process.exit(0);
