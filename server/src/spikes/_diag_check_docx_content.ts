/** Download the actual raw bytes of CXXXXXXXXXXXXXXXXXXX.docx and inspect them
 *  directly, instead of speculating about why it "isn't a zip file". Needs a token
 *  minted with the Drive scope specifically — getSaToken() defaults to
 *  cloud-platform (Vertex AI/Gemini), which 403s against the Drive API.
 *  npx tsx src/spikes/_diag_check_docx_content.ts */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const FILE_ID = '1lKPaAs2ea-1b1Eoj4-_MrpTFS6T9B-8p';

function loadKey(): { client_email: string; private_key: string } {
  const raw = config.GOOGLE_SA_KEY_JSON ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const key = loadKey();
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
    subject: 'zara@storefuze.com',
  });
  const { access_token: saToken } = await client.authorize();

  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${FILE_ID}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('metadata status:', metaRes.status);
  console.log(JSON.stringify(await metaRes.json(), null, 2));

  const contentRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('\ncontent status:', contentRes.status);
  const buf = Buffer.from(await contentRes.arrayBuffer());
  console.log('actual byte length:', buf.length);
  console.log('first 16 bytes (hex):', buf.subarray(0, 16).toString('hex'));
  console.log('as utf8 text:', JSON.stringify(buf.toString('utf8')));
  console.log('starts with ZIP signature (PK)?', buf[0] === 0x50 && buf[1] === 0x4b);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
