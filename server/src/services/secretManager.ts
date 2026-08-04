/**
 * GCP Secret Manager REST API helpers.
 *
 * All operations use a caller-supplied GCP OAuth access token (cloud-platform scope).
 * No Google SDK dependency — pure fetch calls.
 */

import { logger } from '../logger.js';

const SM_BASE = 'https://secretmanager.googleapis.com/v1';

// ── Low-level helpers ─────────────────────────────────────────────────────────

async function smFetch(
  token: string,
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function checkOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Secret Manager ${label} failed (${res.status}): ${text}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Enable the Secret Manager API in the given project. */
export async function enableSecretManagerApi(token: string, projectId: string): Promise<void> {
  const url =
    `https://serviceusage.googleapis.com/v1/projects/${projectId}` +
    `/services/secretmanager.googleapis.com:enable`;
  const res = await smFetch(token, url, 'POST', {});
  // 400 = already enabled; treat as success
  if (!res.ok && res.status !== 400) {
    const text = await res.text().catch(() => res.statusText);
    logger.warn({ projectId, status: res.status, text }, 'enableSecretManagerApi non-fatal');
  }
}

/**
 * Create a secret (if it does not exist) and add a new version with the given value.
 * Ignores 409 (already exists) on creation.
 */
export async function upsertSecret(
  token: string,
  projectId: string,
  secretId: string,
  value: string,
): Promise<void> {
  const base = `${SM_BASE}/projects/${projectId}/secrets`;

  // Create — secretId is a query param per SM REST API spec; ignore 409 (already exists)
  const createRes = await smFetch(token, `${base}?secretId=${encodeURIComponent(secretId)}`, 'POST', {
    replication: { automatic: {} },
    labels: { managed_by: 'studio-enterprise' },
  });
  if (!createRes.ok && createRes.status !== 409) {
    await checkOk(createRes, `create secret "${secretId}"`);
  }

  // Add version (value base64-encoded per Secret Manager API contract)
  const versionRes = await smFetch(token, `${base}/${secretId}:addVersion`, 'POST', {
    payload: { data: Buffer.from(value).toString('base64') },
  });
  await checkOk(versionRes, `addVersion for "${secretId}"`);

  logger.info({ projectId, secretId }, 'secret upserted');
}

/**
 * Grant secretAccessor on a secret to a service account.
 * Merges with existing bindings (does not replace the full policy).
 */
export async function grantSecretAccess(
  token: string,
  projectId: string,
  secretId: string,
  serviceAccountEmail: string,
): Promise<void> {
  const secretResource = `${SM_BASE}/projects/${projectId}/secrets/${secretId}`;
  const member = `serviceAccount:${serviceAccountEmail}`;
  const role = 'roles/secretmanager.secretAccessor';

  // Fetch existing policy so we can merge
  type Binding = { role: string; members: string[] };
  let bindings: Binding[] = [];
  const getRes = await smFetch(token, `${secretResource}:getIamPolicy`);
  if (getRes.ok) {
    const existing = (await getRes.json()) as { bindings?: Binding[] };
    bindings = existing.bindings ?? [];
  }

  const existing = bindings.find((b) => b.role === role);
  if (existing) {
    if (!existing.members.includes(member)) existing.members.push(member);
  } else {
    bindings.push({ role, members: [member] });
  }

  const setRes = await smFetch(token, `${secretResource}:setIamPolicy`, 'POST', {
    policy: { bindings },
  });
  await checkOk(setRes, `setIamPolicy for "${secretId}"`);
  logger.info({ projectId, secretId, serviceAccountEmail }, 'secret IAM granted');
}

/** Return the numeric project number for a GCP project ID. */
export async function getProjectNumber(token: string, projectId: string): Promise<string> {
  const res = await smFetch(
    token,
    `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`,
  );
  await checkOk(res, `getProject "${projectId}"`);
  const json = (await res.json()) as { projectNumber?: string };
  if (!json.projectNumber) throw new Error(`No projectNumber in project response for ${projectId}`);
  return json.projectNumber;
}

// ── High-level orchestrator ───────────────────────────────────────────────────

export interface MsCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  orgUrl: string;
}

export const SECRET_IDS = {
  tenantId: 'studio-enterprise-ms-tenant-id',
  clientId: 'studio-enterprise-ms-client-id',
  clientSecret: 'studio-enterprise-ms-client-secret',
  orgUrl: 'studio-enterprise-ms-org-url',
} as const;

/**
 * Store MS credentials as four secrets in the customer's GCP project,
 * then grant the Workflows SA secretAccessor on each.
 */
export async function setupMsCredentials(
  token: string,
  projectId: string,
  creds: MsCredentials,
  workflowsSaEmail: string,
): Promise<{ secretIds: Record<keyof MsCredentials, string> }> {
  logger.info({ projectId, workflowsSaEmail }, 'setupMsCredentials start');

  await enableSecretManagerApi(token, projectId);

  const entries = Object.entries(SECRET_IDS) as Array<[keyof MsCredentials, string]>;
  for (const [field, secretId] of entries) {
    await upsertSecret(token, projectId, secretId, creds[field]);
    await grantSecretAccess(token, projectId, secretId, workflowsSaEmail);
  }

  logger.info({ projectId }, 'setupMsCredentials done');
  return { secretIds: { ...SECRET_IDS } };
}

// ── Entra credential helpers (CloudFuze-project-scoped) ───────────────────────
// Store Entra app secrets in CloudFuze's OWN GCP project (CLOUDFUZE_GCP_PROJECT),
// not the customer's. Plaintext is never written to Mongo; only the versioned
// secret resource name is (db/repos/entraAppCredentials.ts).

export interface PutSecretResult {
  ok: boolean;
  versionName?: string;
  error?: string;
}

export async function putEntraSecret(
  project: string,
  saToken: string,
  secretId: string,
  plaintext: string,
): Promise<PutSecretResult> {
  const createRes = await fetch(`${SM_BASE}/projects/${project}/secrets?secretId=${encodeURIComponent(secretId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replication: { automatic: {} } }),
  });
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    if (createRes.status !== 409 && !text.includes('already exists')) {
      logger.warn({ status: createRes.status, secretId }, 'Secret Manager: create secret failed');
      return { ok: false, error: `${createRes.status}: ${text.slice(0, 200)}` };
    }
  }
  const versionRes = await fetch(`${SM_BASE}/projects/${project}/secrets/${secretId}:addVersion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(plaintext, 'utf8').toString('base64') } }),
  });
  if (!versionRes.ok) {
    const text = await versionRes.text().catch(() => '');
    logger.warn({ status: versionRes.status, secretId }, 'Secret Manager: add version failed');
    return { ok: false, error: `${versionRes.status}: ${text.slice(0, 200)}` };
  }
  const json = (await versionRes.json()) as { name?: string };
  if (!json.name) return { ok: false, error: 'addVersion succeeded but returned no version name' };
  return { ok: true, versionName: json.name };
}

export interface GetSecretResult {
  ok: boolean;
  plaintext?: string;
  error?: string;
}

export async function getEntraSecret(saToken: string, versionName: string): Promise<GetSecretResult> {
  const res = await fetch(`${SM_BASE}/${versionName}:access`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status }, 'Secret Manager: access version failed');
    return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
  }
  const json = (await res.json()) as { payload?: { data?: string } };
  if (!json.payload?.data) return { ok: false, error: 'access succeeded but returned no payload' };
  return { ok: true, plaintext: Buffer.from(json.payload.data, 'base64').toString('utf8') };
}
