/**
 * Phase 2 (Google-only): creates/updates the real Application Integration resources a
 * translated flow (`MappedFlowIntegration`, from services/flowMapper.ts) needs, and
 * ensures the AuthConfig(s) it depends on exist. Never touches Dataverse — see
 * .claude/rules/architecture-boundaries.md.
 *
 * KNOWN LIMITATION, flagged rather than hidden: Application Integration has a `location`
 * concept (e.g. "us-east1") with no home anywhere in this codebase's `GeminiDestination`
 * today (Discovery Engine's own LOCATION is unrelated and always "global"). Hardcoded to
 * the one region this session verified live against. A real client-agnostic destination
 * needs to discover/select this properly — same "never hardcode" principle the rest of
 * this tool applies to the Gemini engine id — before this ships to a second customer
 * project. Tracked, not solved, here.
 */
import { logger } from '../logger.js';
import { getEntraSecret } from './secretManager.js';
import { getConnectorCredential } from '../db/repos/connectorCredentials.js';
import { CONNECTOR_REGISTRY } from '../connectors/registry.js';
import { getFlowIntegration, recordFlowIntegration, hashDefinition } from '../db/repos/flowIntegrations.js';
import { getFlowAuthConfigHash, recordFlowAuthConfigHash } from '../db/repos/flowAuthConfigs.js';
import { integrationNameForFlow } from './flowMapper.js';
import type { MappedFlowIntegration } from '../types.js';

const LOCATION = 'us-east1';
const hostV1 = (project: string) => `https://${LOCATION}-integrations.googleapis.com/v1/projects/${project}/locations/${LOCATION}`;

export interface EnsureAuthConfigResult {
  ok: boolean;
  error?: string;
}

/**
 * Makes sure an AuthConfig with the given displayName exists in `project` AND still
 * carries the customer's CURRENT credential — creating it from, or updating it to match,
 * the same Secret Manager fields an agent-level tool on the same credential group already
 * reads. Every connector sharing the group is tried in turn — whichever one the customer
 * actually configured (Teams, OneDrive, ...) supplies the same underlying app registration.
 *
 * A rotated client secret (or a replaced app registration) is a real, expected event —
 * not an edge case — so "the AuthConfig already exists" is deliberately NOT treated as
 * "nothing to do": Application Integration stores credentials write-only (never returns
 * the plaintext back), so there is no way to ask Google whether it's stale. Instead this
 * hashes the CURRENT stored credential values and compares against what was last written
 * (db/repos/flowAuthConfigs.ts) — the same idiom secretManager.ts's upsertSecretIfChanged
 * already uses for plain secrets. A changed hash means a real PATCH with the fresh values,
 * confirmed live to work (Application Integration's authConfigs support
 * `PATCH .../authConfigs/{id}?updateMask=...`).
 */
export async function ensureAuthConfig(
  saToken: string,
  project: string,
  appUserId: string,
  authConfigName: string,
): Promise<EnsureAuthConfigResult> {
  try {
    return await ensureAuthConfigInner(saToken, project, appUserId, authConfigName);
  } catch (e) {
    // A raw network failure (ECONNRESET, DNS, TLS) throws instead of returning a
    // response — never let that escape as an unhandled rejection. The caller
    // (orchestrator.ts) treats a returned {ok:false} as a needs-review fidelity note
    // on this one flow; an escaped throw instead kills the ENTIRE agent insert, which
    // is exactly the failure this session traced (a transient reset while creating
    // one flow's AuthConfig took down the whole "Deal Desk" insert, not just that flow).
    logger.warn({ authConfigName, err: String(e) }, 'applicationIntegration: ensureAuthConfig threw, treating as failure');
    return { ok: false, error: `network error: ${String(e)}` };
  }
}

/**
 * Pick which stored credential record an AuthConfig is built from, when a credential group
 * spans several connectors whose records point at DIFFERENT Secret Manager projects.
 *
 * The destination project WINS. A migration run authenticates as the customer admin by
 * Domain-Wide Delegation, and that identity has access to the customer's own project only
 * — it is 403 on ours, correctly. The run copies the credentials into the destination
 * before this point, so a record there is always the readable one. Taking whichever record
 * the registry happened to list first read from OUR project instead and failed the whole
 * AuthConfig with "secret(s) could not be read", which deployed the flow with no way to get
 * a token: a tool that exists, answers, and never works.
 *
 * Falls back to any other record so a run that has not copied credentials yet still works
 * when the caller's identity does reach that project (the service account's own token does).
 */
export function pickCredentialRecord<T extends { project: string }>(
  records: T[],
  destinationProject: string,
): T | undefined {
  return records.find((r) => r.project === destinationProject) ?? records[0];
}

async function ensureAuthConfigInner(
  saToken: string,
  project: string,
  appUserId: string,
  authConfigName: string,
): Promise<EnsureAuthConfigResult> {
  const candidates = CONNECTOR_REGISTRY.filter((d) => d.credentialGroup === authConfigName || d.id === authConfigName);
  const stored: { project: string; secretIds: Record<string, string> }[] = [];
  for (const def of candidates) {
    const rec = await getConnectorCredential(appUserId, def.id);
    if (rec?.project && rec.secretIds?.tenant_id && rec.secretIds.client_id && rec.secretIds.client_secret) {
      stored.push({ project: rec.project, secretIds: rec.secretIds });
    }
  }
  const chosen = pickCredentialRecord(stored, project);
  if (!chosen) {
    return { ok: false, error: `No stored Microsoft credentials found for credential group "${authConfigName}" — configure it the same way an agent-level connector tool on this group would.` };
  }
  const { secretIds, project: secretsProject } = chosen;

  const [tenantId, clientId, clientSecret] = await Promise.all([
    getEntraSecret(saToken, `projects/${secretsProject}/secrets/${secretIds.tenant_id}/versions/latest`),
    getEntraSecret(saToken, `projects/${secretsProject}/secrets/${secretIds.client_id}/versions/latest`),
    getEntraSecret(saToken, `projects/${secretsProject}/secrets/${secretIds.client_secret}/versions/latest`),
  ]);
  if (!tenantId.ok || !clientId.ok || !clientSecret.ok) {
    // Name the project. The same secret ids exist in several projects, so "could not be
    // read" without one sent a live diagnosis chasing the wrong credential entirely.
    return { ok: false, error: `Stored credential secret(s) in project "${secretsProject}" could not be read.` };
  }
  const currentHash = hashDefinition({ tenantId: tenantId.plaintext, clientId: clientId.plaintext, clientSecret: clientSecret.plaintext });

  const listRes = await fetch(`${hostV1(project)}/authConfigs`, { headers: { Authorization: `Bearer ${saToken}` } });
  let existingName: string | undefined;
  if (listRes.ok) {
    const j = (await listRes.json()) as { authConfigs?: { name?: string; displayName?: string }[] };
    existingName = (j.authConfigs ?? []).find((a) => a.displayName === authConfigName)?.name;
  }

  const decryptedCredential = {
    credentialType: 'OAUTH2_CLIENT_CREDENTIALS',
    oauth2ClientCredentials: {
      clientId: clientId.plaintext,
      clientSecret: clientSecret.plaintext,
      tokenEndpoint: `https://login.microsoftonline.com/${tenantId.plaintext}/oauth2/v2.0/token`,
      scope: 'https://graph.microsoft.com/.default',
      requestType: 'REQUEST_BODY',
    },
  };

  if (existingName) {
    const storedHash = await getFlowAuthConfigHash(appUserId, project, authConfigName);
    if (storedHash === currentHash) return { ok: true }; // credential unchanged since we last wrote it

    logger.info({ authConfigName }, 'applicationIntegration: stored credential changed — updating AuthConfig in place');
    const patchRes = await fetch(`https://${LOCATION}-integrations.googleapis.com/v1/${existingName}?updateMask=decryptedCredential`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decryptedCredential }),
    });
    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => '');
      return { ok: false, error: `AuthConfig update ${patchRes.status}: ${text.slice(0, 300)}` };
    }
    await recordFlowAuthConfigHash(appUserId, project, authConfigName, currentHash);
    return { ok: true };
  }

  const createRes = await fetch(`${hostV1(project)}/authConfigs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: authConfigName, decryptedCredential }),
  });
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    return { ok: false, error: `${createRes.status}: ${text.slice(0, 300)}` };
  }
  await recordFlowAuthConfigHash(appUserId, project, authConfigName, currentHash);
  return { ok: true };
}

export interface EnsureFlowIntegrationResult {
  ok: boolean;
  integrationName?: string;
  triggerId?: string;
  executeUrl?: string;
  skippedUnchanged?: boolean;
  error?: string;
}

/**
 * Idempotently create-or-version-update the real Application Integration for one
 * translated flow. Reuses the SAME integration name across re-runs (deterministic from
 * the source flow id) and skips the upload entirely when the translated definition is
 * byte-identical to what's already there — same idempotency discipline as
 * db/repos/adkDeployments.ts, one layer down.
 */
export async function ensureFlowIntegration(
  saToken: string,
  project: string,
  appUserId: string,
  envUrl: string,
  flow: MappedFlowIntegration,
): Promise<EnsureFlowIntegrationResult> {
  // RETRY A TRANSIENT, don't lose the tool to it. Creating a flow is several sequential
  // uploads, and a single blip drops that tool from the deployed agent PERMANENTLY -- the
  // agent still deploys, verifies and reports green, one capability short. Observed twice
  // in three consecutive live runs (GetRateSheetBand, then DraftFollwUpEMail), each a bare
  // `TypeError: fetch failed`. Idempotent by definition hash, so a repeat is safe.
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ensureFlowIntegrationInner(saToken, project, appUserId, envUrl, flow);
    } catch (e) {
      // Same discipline as ensureAuthConfig above: a thrown network error (ECONNRESET
      // observed live, 2026-09-06 — mid-upload while recreating "DraftFollwUpEMail")
      // must degrade to a needs-review fidelity note on THIS flow, never escape and
      // take down the whole agent insert.
      lastErr = String(e);
      logger.warn(
        { flowId: flow.flowId, attempt: attempt + 1, err: lastErr },
        'applicationIntegration: ensureFlowIntegration threw',
      );
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return { ok: false, error: `network error after 3 attempts: ${lastErr}` };
}

async function ensureFlowIntegrationInner(
  saToken: string,
  project: string,
  appUserId: string,
  envUrl: string,
  flow: MappedFlowIntegration,
): Promise<EnsureFlowIntegrationResult> {
  const integrationName = integrationNameForFlow(flow.flowName);
  const definitionHash = hashDefinition(flow.integrationDefinition);
  const existing = await getFlowIntegration(appUserId, envUrl, flow.flowId, project, LOCATION);
  const triggerId = `api_trigger/${integrationName}_API_1`;
  const executeUrl = `https://integrations.googleapis.com/v2/projects/${project}/locations/${LOCATION}/integrations/${integrationName}:execute?triggerId=${triggerId}`;

  if (existing && existing.definitionHash === definitionHash) {
    // A matching hash in OUR record is not proof the resource still exists — Application
    // Integration has no signal that tells US when a customer deletes one out-of-band (a
    // real, observed action: deleting integrations manually via the console to force a
    // clean re-test). Trusting the stored hash alone left a PATCHed agent pointing its
    // flow tool at a deleted resource, 404ing at inference with no warning anywhere. A
    // live existence check is cheap (one GET) next to a silently broken deployed tool.
    const checkRes = await fetch(`${hostV1(project)}/integrations/${integrationName}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (checkRes.ok) {
      return { ok: true, integrationName, triggerId, executeUrl, skippedUnchanged: true };
    }
    logger.info(
      { flowId: flow.flowId, integrationName, status: checkRes.status },
      'applicationIntegration: recorded as up to date but the resource is gone (deleted out-of-band) — recreating',
    );
  }

  const uploadRes = await fetch(`${hostV1(project)}/integrations/${integrationName}/versions:upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(flow.integrationDefinition), fileFormat: 'JSON' }),
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    logger.warn({ flowId: flow.flowId, status: uploadRes.status }, 'applicationIntegration: upload failed');
    return { ok: false, error: `upload ${uploadRes.status}: ${text.slice(0, 300)}` };
  }
  const uploadJson = (await uploadRes.json()) as { integrationVersion?: { name?: string } };
  const versionName = uploadJson.integrationVersion?.name;
  if (!versionName) return { ok: false, error: 'upload succeeded but returned no version name' };
  const versionId = versionName.split('/').pop()!;

  const publishRes = await fetch(`${hostV1(project)}/integrations/${integrationName}/versions/${versionId}:publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!publishRes.ok) {
    const text = await publishRes.text().catch(() => '');
    logger.warn({ flowId: flow.flowId, status: publishRes.status }, 'applicationIntegration: publish failed');
    return { ok: false, error: `publish ${publishRes.status}: ${text.slice(0, 300)}` };
  }

  await recordFlowIntegration(appUserId, envUrl, flow.flowId, project, LOCATION, {
    integrationName,
    latestVersionId: versionId,
    definitionHash,
  });
  return { ok: true, integrationName, triggerId, executeUrl };
}
