/**
 * Throwaway diag: print a project's metadata (createTime, parent, lifecycleState)
 * using the session's stored OAuth token.
 *   cd server && npx tsx src/_diag_project_meta.ts <sessionId> <projectId>
 */
import { getSession } from './sessionStore.js';

const sessionId = process.argv[2] || 'DqtePTQXNY0akgptTxm_CS5Pzw8';
const projectId = process.argv[3] || 'sonorous-lightning-t224x';

const s = await getSession(sessionId);
if (!s?.gToken) {
  console.error(`no gToken on session ${sessionId} (expired? try a fresh connect and pass the new session id)`);
  process.exit(1);
}

const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`, {
  headers: { Authorization: `Bearer ${s.gToken}` },
});
console.log('status:', res.status);
const j = await res.json();
console.log(JSON.stringify(j, null, 2));
