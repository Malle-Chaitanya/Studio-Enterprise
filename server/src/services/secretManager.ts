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
 * Entra app credentials live under CLOUDFUZE'S OWN GCP project
 * (config.CLOUDFUZE_GCP_PROJECT). The plaintext is never written to Mongo; only
 * the versioned secret resource name is (db/repos/entraAppCredentials.ts).
 *
 * CONNECTOR credentials are different and must NOT be moved to our project without
 * more work: `upsertSecret` writes them to the DEPLOYMENT project because the
 * deployed container resolves them from its own project id at inference time
 * (scripts/adk_deploy.py — `projects/{project}/secrets/{id}/versions/latest:access`).
 * Writing them anywhere else deploys a healthy-looking agent whose every tool call
 * then 403s. Splitting the two requires passing a separate secrets project through
 * to the container; see handoff.md item 2.
 */

const HOST = 'https://secretmanager.googleapis.com/v1';

export interface SecretAccessCheck {
  ok: boolean;
  /** Stable machine code for the route to return; see api-conventions.md. */
  code?: 'secret_manager_access_denied' | 'secret_manager_project_not_found' | 'secret_manager_unavailable';
  /** Human detail naming the real cause and the exact grant that fixes it. */
  detail?: string;
}

/**
 * Can our service account actually WRITE secrets into `project`?
 *
 * Called before the first credential is stored. Without it the flow fails on the
 * write itself, deep inside a loop, and the UI reported the misleading
 * "Check that Google is connected" — Google WAS connected; our SA simply had no
 * Secret Manager rights on the target project. A wrong cause costs more than a
 * failure, because the admin goes and re-checks the thing that was never broken.
 *
 * Listing is the cheapest call that exercises the same IAM the write needs, and it
 * creates nothing when it succeeds.
 */
export async function preflightSecretAccess(
  project: string,
  saToken: string,
  saEmail?: string,
): Promise<SecretAccessCheck> {
  let res: Response;
  try {
    res = await fetch(`${HOST}/projects/${project}/secrets?pageSize=1`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
  } catch (err) {
    // Network-level failure is not an authorization answer — say so rather than
    // blaming the customer's IAM.
    return {
      ok: false,
      code: 'secret_manager_unavailable',
      detail: `Could not reach Secret Manager: ${(err as Error).message}`,
    };
  }
  if (res.ok) return { ok: true };

  const body = await res.text().catch(() => '');
  const who = saEmail ?? 'our service account';
  if (res.status === 403) {
    const apiDisabled = /SERVICE_DISABLED|has not been used in project|is disabled/i.test(body);
    return {
      ok: false,
      code: 'secret_manager_access_denied',
      detail: apiDisabled
        ? `The Secret Manager API is not enabled on project "${project}". Enable it: gcloud services enable secretmanager.googleapis.com --project ${project}`
        : // Google answers 403 for a project that does not exist as well as for one we
          // simply cannot touch — it will not confirm existence. Saying only "grant this
          // role" sends an admin to run a command against a project that isn't there, so
          // name both possibilities and let them check the id first.
          `${who} cannot manage secrets in project "${project}". Either the project id is wrong, ` +
          `or the service account needs access — grant it: ` +
          `gcloud projects add-iam-policy-binding ${project} --member serviceAccount:${who} --role roles/secretmanager.admin`,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      code: 'secret_manager_project_not_found',
      detail: `Project "${project}" was not found, or ${who} cannot see it.`,
    };
  }
  logger.warn({ status: res.status, project }, 'Secret Manager: preflight failed');
  return {
    ok: false,
    code: 'secret_manager_unavailable',
    detail: `Secret Manager returned ${res.status}: ${body.slice(0, 200)}`,
  };
}

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

/**
 * Upsert a connector credential into a CUSTOMER'S Google Cloud project.
 * Signature matches what migrate.ts expects: (saToken, project, secretId, value).
 * Re-uses the existing create-then-addVersion pattern.
 */
export async function upsertSecret(
  saToken: string,
  project: string,
  secretId: string,
  plaintext: string,
): Promise<void> {
  const result = await putEntraSecret(project, saToken, secretId, plaintext);
  if (!result.ok) throw new Error(result.error ?? 'upsertSecret failed');
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
