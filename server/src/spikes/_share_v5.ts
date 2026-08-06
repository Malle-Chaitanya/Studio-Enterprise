import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
const tok = await getSaToken('mia@cloudfuze.com');
const dest = await resolveDestination('sonorous-lightning-t224x', tok);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;
const r = await fetch(`${base}/agents/4003993719884630290?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log('Share:', r.status, r.ok ? 'OK ✓' : await r.text());
