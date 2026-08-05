import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { deleteAgent } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

async function main() {
  const saToken = await getSaToken();
  const del = await deleteAgent(DEST, saToken, '1238471887308860960');
  console.log('deleted broken agent:', JSON.stringify(del));
}
main().catch((e) => console.error('FAILED:', e.message));
