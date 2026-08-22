/**
 * Every field a deployed tool asks for with `secret("x")` must be declared in the registry —
 * otherwise it never reaches `secretIds`, the container reads an empty string, and the feature
 * is unreachable no matter what the customer configures.
 *
 * Found live 2026-08-22: teams.py reads `impersonate_email`, MS_GRAPH_FIELDS declares only
 * tenant_id/client_id/client_secret, so "No user is configured for this agent" could not be
 * fixed from the UI at all. Saving the secret by hand did not help either — nothing referenced
 * it. chat.py's `chat_app_configured` write-gate has the same shape.
 */
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { connectorCredentialFields } from '../services/connectorCredentials.js';

/** Which module serves which connector — mirrors toolModule.ts resolution. */
const MODULE_FOR: Record<string, string[]> = {
  teams: ['shared_teams'],
  chat: ['shared_googlechat'],
  outlook: ['shared_outlook', 'shared_office365'],
  gmail: ['shared_gmail'],
  confluence: ['shared_confluence'],
  sharepoint: ['shared_sharepointonline', 'shared_onedrive'],
  google_drive: ['shared_googledrive'],
  jira: ['shared_jira'],
};
/** What each module reads at runtime (from the secret("...") scan). */
const READS: Record<string, string[]> = {
  teams: ['impersonate_email'],
  chat: ['chat_app_configured', 'impersonate_email'],
  outlook: ['impersonate_email'],
  // gmail deliberately omitted: its mailbox is ALWAYS per-agent, injected into secretIds by the
  // orchestrator's surface-mailbox handling ("WHICH mailbox each agent reads is set per-agent"),
  // never a tenant-wide default. A registry field here would invite one mailbox for every agent,
  // which is the opposite of the design.

  confluence: ['api_token', 'base_url', 'email'],
};

let gaps = 0;
for (const [mod, reads] of Object.entries(READS)) {
  for (const connectorId of MODULE_FOR[mod] ?? []) {
    if (!REGISTRY_BY_ID.has(connectorId)) continue;
    const declared = new Set(connectorCredentialFields(connectorId).map((f) => f.key));
    for (const field of reads) {
      const ok = declared.has(field);
      if (!ok) gaps++;
      console.log(`${ok ? 'OK  ' : 'GAP '} ${connectorId.padEnd(28)} ${mod}.py reads "${field}"${ok ? '' : '  <-- NOT declared; unreachable'}`);
    }
  }
}
console.log(`\n${gaps} gap(s). Declared fields per Microsoft connector:`);
for (const id of ['shared_teams', 'shared_outlook', 'shared_sharepointonline']) {
  const d = REGISTRY_BY_ID.get(id);
  if (!d) continue;
  console.log(`  ${id.padEnd(28)} ${connectorCredentialFields(id).map((f) => f.key).join(', ')}`);
}
process.exit(0);
