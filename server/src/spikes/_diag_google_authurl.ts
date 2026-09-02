import { config } from '../config.js';
import * as google from '../auth/google.js';

const url = google.buildAuthUrl('teststate');
const u = new URL(url);
const p = u.searchParams;
const cid = p.get('client_id') ?? '';
console.log('redirect_uri :', p.get('redirect_uri'));
console.log('client_id    :', cid.slice(0, 12) + '...' + cid.slice(-18), `(len ${cid.length})`);
console.log('prompt       :', p.get('prompt'));
console.log('access_type  :', p.get('access_type'));
console.log('total URL len:', url.length);
const scopes = (p.get('scope') ?? '').split(/[\s,]+/).filter(Boolean);
console.log('scope count  :', scopes.length, ' raw len', (p.get('scope') ?? '').length);
for (const s of scopes) console.log('   ', s);
console.log('WEB_ORIGIN   :', config.WEB_ORIGIN);
