import { config } from '../config.js';
console.log('GOOGLE_SA_KEY_FILE set:', Boolean((config as any).GOOGLE_SA_KEY_FILE));
console.log('GOOGLE_SA_KEY_JSON set:', Boolean((config as any).GOOGLE_SA_KEY_JSON));
console.log('GEMINI_PROJECT_FALLBACK:', (config as any).GEMINI_PROJECT_FALLBACK || '(none)');
const keyFile = (config as any).GOOGLE_SA_KEY_FILE as string | undefined;
if (keyFile) {
  try {
    const fs = await import('node:fs');
    const raw = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
    console.log('SA client_email:', raw.client_email);
    console.log('SA project_id:', raw.project_id);
  } catch (e) {
    console.log('Could not read key file contents:', (e as Error).message);
  }
}
