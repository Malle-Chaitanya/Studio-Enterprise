/** Closes PERMISSION-MAPPING-ARCHITECTURE.md §1a's open question: GEMINI-CHATBOT-CLAIMS-
 *  FACTCHECK.md already proved :publish does NOT flip a low-code agent's `state` from
 *  PRIVATE to ENABLED (200 response, state unchanged) — but nobody has confirmed what
 *  :publish DOES do. The real Agent resource has an `activeRevision` field alongside
 *  `state`; this probes whether :publish promotes a draft edit to that active/live
 *  revision (a third axis, distinct from both `state` and `sharingConfig`), by editing
 *  the agent's displayName, reading it back BEFORE :publish, calling :publish, then
 *  reading it back AFTER — and diffing activeRevision/updateTime/displayName each time.
 *  No mongo. Token via SA key + GOOGLE_IMPERSONATE_EMAIL.
 *   npx tsx src/spikes/_diag_probe_publish_effect.ts <project> <engineId> <agentId> */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;

interface AgentSnapshot {
  state?: string;
  activeRevision?: string;
  updateTime?: string;
  displayName?: string;
  draftDisplayName?: string;
}

async function snapshot(token: string, label: string): Promise<AgentSnapshot> {
  const r = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await r.json()) as AgentSnapshot & { lowCodeAgentDefinition?: { draftDisplayName?: string } };
  const snap: AgentSnapshot = {
    state: j.state,
    activeRevision: j.activeRevision,
    updateTime: j.updateTime,
    displayName: j.displayName,
    draftDisplayName: j.lowCodeAgentDefinition?.draftDisplayName,
  };
  console.log(`[${label}] ${JSON.stringify(snap)}`);
  return snap;
}

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) {
    throw new Error('usage: _diag_probe_publish_effect.ts <project> <engineId> <agentId>');
  }
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const before = await snapshot(token, 'BEFORE edit');

  // Edit the DRAFT display name only — the live displayName should be unaffected until
  // (if ever) :publish promotes the draft to active.
  const probeName = `${before.draftDisplayName ?? before.displayName ?? 'Agent'} [publish-probe]`;
  const patchRes = await fetch(`${BASE}?updateMask=lowCodeAgentDefinition.draftDisplayName`, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ lowCodeAgentDefinition: { draftDisplayName: probeName } }),
  });
  console.log(`\nPATCH draftDisplayName -> ${patchRes.status}`);
  const afterEdit = await snapshot(token, 'AFTER draft edit, BEFORE publish');

  const publishRes = await fetch(`${BASE}:publish`, { method: 'POST', headers: h, body: '{}' });
  console.log(`\n:publish -> ${publishRes.status}  ${(await publishRes.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
  const afterPublish = await snapshot(token, 'AFTER publish');

  console.log(
    '\nRead the three snapshots above: if displayName changes to include "[publish-probe]" only ' +
      'AFTER the :publish call (not right after the draft PATCH), that confirms :publish promotes ' +
      'draft content to a live/active revision — a real, distinct effect, separate from `state`. If ' +
      'displayName never changes at all, or changes immediately on PATCH regardless of :publish, ' +
      'that disproves the activeRevision hypothesis and :publish should be treated as a no-op for ' +
      'low-code agents until a different real effect is found.',
  );
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});