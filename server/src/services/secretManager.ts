import { logger } from '../logger.js';

/**
 * GCP Secret Manager REST wrapper — stores a customer's Entra app client
 * secret ONCE PER TENANT so a new SharePoint/OneDrive site under an
 * already-onboarded tenant can auto-provision a connector with no repeat
 * admin interaction (see .claude/memory/decisions.md, 2026-08-03).
 *
 * Deliberately plain `fetch` + SA bearer token, matching this codebase's
 * existing convention (geminiDataStore.ts, geminiConnector.ts) of hand-rolled
 * REST calls over a Google Cloud client SDK — no new npm dependency; the
 * existing `cloud-platform` SA scope (auth/google.ts's SA_SCOPES) already
 * covers Secret Manager.
 *
 * Secrets live under CLOUDFUZE'S OWN GCP project (config.CLOUDFUZE_GCP_PROJECT)
 * — never the customer's project. The plaintext is never written to Mongo;
 * only the versioned secret resource name is (db/repos/entraAppCredentials.ts).
 */

const HOST = 'https://secretmanager.googleapis.com/v1';

export interface PutSecretResult {
  ok: boolean;
  /** Full versioned resource name: projects/{project}/secrets/{id}/versions/{version}. */
  versionName?: string;
  error?: string;
}

/**
 * Store `plaintext` as a new version of `secretId` under `project`, creating
 * the secret container first if it doesn't exist yet (409-as-already-exists,
 * same idempotency convention as createDataStore in geminiDataStore.ts).
 */
export async function putEntraSecret(
  project: string,
  saToken: string,
  secretId: string,
  plaintext: string,
): Promise<PutSecretResult> {
  const createRes = await fetch(`${HOST}/projects/${project}/secrets?secretId=${encodeURIComponent(secretId)}`, {
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

  const versionRes = await fetch(`${HOST}/projects/${project}/secrets/${secretId}:addVersion`, {
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

/**
 * Fetch a secret version's plaintext for one-shot, in-stack-frame use in a
 * setUpDataConnector call — the caller must not cache or persist the result.
 */
export async function getEntraSecret(saToken: string, versionName: string): Promise<GetSecretResult> {
  const res = await fetch(`${HOST}/${versionName}:access`, {
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
