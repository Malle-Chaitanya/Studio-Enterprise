/** Does the SAME project id resolve to a different number under DWD impersonation? */
import { getSaToken } from '../auth/google.js';
const P = 'studio-enterprise-migration';
for (const who of [undefined, 'admin@migrationn.com']) {
  try {
    const t = await getSaToken(who);
    const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${P}`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    const b = await r.json() as { projectNumber?: string; projectId?: string; name?: string };
    console.log(`as ${who ?? 'SA (no impersonation)'} -> ${r.status}`,
      'projectId:', b.projectId, 'number:', b.projectNumber, 'name:', b.name);
  } catch (e) {
    console.log(`as ${who ?? 'SA'} -> ERROR`, (e as Error).message.slice(0, 140));
  }
}
