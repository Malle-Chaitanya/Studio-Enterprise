/** Ask a deployed agent a question and show the raw tool evidence. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { chatWithAdkAgent, createAdkSession } from '../services/adkAgentChat.js';
const PROJECT = 'studio-enterprise-migration';
const RE = process.argv[2]!;
const Q = process.argv[3] ?? 'How many tickets do we have in Jira?';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const sid = await createAdkSession(PROJECT, access_token!, RE, 'cf-probe');
const r = await chatWithAdkAgent(PROJECT, access_token!, { reasoningEngineId: RE, message: Q, userId: 'cf-probe', sessionId: sid ?? undefined });
console.log(`Q: ${Q}\n`);
console.log(`ok=${r.ok} toolCalled=${r.toolCalled} toolSucceeded=${r.toolSucceeded}`);
console.log(`toolError: ${r.toolError ?? '-'}`);
console.log(`\nANSWER:\n${(r.answer ?? r.error ?? '(none)').slice(0, 1200)}`);
process.exit(0);
