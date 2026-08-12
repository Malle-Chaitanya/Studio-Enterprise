/**
 * Isolate whether DWD is actually authorizing drive.readonly for Erik, outside
 * the deployed container entirely — mints a token with exactly that one scope.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const IMPERSONATE = 'erik@filefuze.co';

function saKey(): Record<string, unknown> {
  if (config.GOOGLE_SA_KEY_JSON) return JSON.parse(config.GOOGLE_SA_KEY_JSON);
  if (config.GOOGLE_SA_KEY_FILE) return JSON.parse(readFileSync(config.GOOGLE_SA_KEY_FILE, 'utf8'));
  throw new Error('no SA key configured');
}

async function tryScope(scopes: string[]) {
  const key = saKey();
  const client = new JWT({
    email: key.client_email as string,
    key: key.private_key as string,
    scopes,
    subject: IMPERSONATE,
  });
  try {
    const { access_token } = await client.authorize();
    console.log(`OK   [${scopes.join(', ')}] -> token length ${access_token?.length}`);
  } catch (e) {
    console.log(`FAIL [${scopes.join(', ')}] -> ${(e as Error).message}`);
  }
}

async function main() {
  await tryScope(['https://www.googleapis.com/auth/cloud-platform']);
  await tryScope(['https://www.googleapis.com/auth/drive']);
  await tryScope(['https://www.googleapis.com/auth/drive.readonly']);
}
main().catch((e) => console.error('FAILED:', e.message));
