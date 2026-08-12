/** Ask an already-deployed Reasoning Engine a question. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent, createAdkSession } from '../services/adkAgentChat.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const ENGINE = process.argv[2]!;
const Q = process.argv[3]!;
const saToken = await getSaToken();
const userId = 'cf-bound-tool-proof';
const sessionId = await createAdkSession(PROJECT, saToken, ENGINE, userId);
const r = await chatWithAdkAgent(PROJECT, saToken, { reasoningEngineId: ENGINE, message: Q, userId, sessionId: sessionId ?? undefined });
console.log(JSON.stringify(r, null, 2).slice(0, 3000));
process.exit(0);
