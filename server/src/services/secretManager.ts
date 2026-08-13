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

/**
 * GCP label keys and values accept lowercase letters, digits, dashes and underscores
 * only, and must start with a letter. Anything else is rejected for the whole request,
 * so an id we cannot express safely is dropped rather than allowed to fail the write.
 */
function safeLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!v) continue;
    const key = k.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63);
    const value = v.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63);
    if (/^[a-z]/.test(key)) out[key] = value;
  }
  return out;
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
  labels?: Record<string, string>,
): Promise<PutSecretResult> {
  const createRes = await fetch(`${HOST}/projects/${project}/secrets?secretId=${encodeURIComponent(secretId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replication: { automatic: {} }, ...(labels ? { labels: safeLabels(labels) } : {}) }),
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

/**
 * Make sure a connector secret actually exists in the project an agent is ABOUT TO
 * deploy into, not just the project it was originally saved to.
 *
 * WHY THIS EXISTS: connector credentials are always written to the session's own
 * connected project (routes/migrate.ts's credentials-save route), but a customer can
 * map one specific Dataverse environment to a DIFFERENT destination project on
 * SelectMap. When that happens, the deployed Reasoning Engine reads its secrets from
 * ITS OWN project — which never received them — and every connector tool call fails
 * with a Secret Manager 404 at inference. Confirmed live 2026-08-13 (Google Drive):
 * the deploy and the per-secret IAM grant both "succeeded" while the secret quietly
 * did not exist where the running agent would ever look for it.
 *
 * Best-effort, mirrors this file's other persistence: a failure here degrades the
 * deployed tool (same as it does today, unchanged) — it must never fail the
 * deployment itself. No-ops when the two projects are the same.
 *
 * Keeps the target in sync on every deploy, not just the first time: an earlier
 * version of this checked "does the target already have SOMETHING" and skipped if
 * so, which fills the gap once but then never notices the canonical value has since
 * CHANGED (e.g. a customer replacing a service-account key) — the deployed agent
 * would keep silently using the stale copy forever. `upsertSecretIfChanged` already
 * compares content, so re-checking that on every deploy costs one extra read and
 * writes a new version only when the value actually moved.
 */
export async function ensureSecretInProject(
  saToken: string,
  sourceProject: string,
  targetProject: string,
  secretId: string,
): Promise<void> {
  if (!sourceProject || sourceProject === targetProject) return;
  try {
    const source = await getEntraSecret(saToken, `projects/${sourceProject}/secrets/${secretId}/versions/latest`);
    if (!source.ok || !source.plaintext) return; // nothing to copy — the existing per-secret-grant failure still reports this
    const { written } = await upsertSecretIfChanged(saToken, targetProject, secretId, source.plaintext);
    if (written) {
      logger.info({ secretId, sourceProject, targetProject }, 'ensureSecretInProject: synced a connector secret to the deploy project');
    }
  } catch (e) {
    logger.warn({ secretId, sourceProject, targetProject, err: (e as Error).message }, 'ensureSecretInProject: sync failed');
  }
}

/**
 * Store a connector credential, but only if it actually differs from what is already
 * there. Returns whether a new version was written.
 *
 * Every save used to add a version unconditionally, and the UI re-posts every field on
 * every save — so re-opening the connector screen and pressing Save produced a fresh
 * version of an identical secret. Versions are billed while enabled and never expire,
 * so a customer adjusting one field slowly accumulated duplicates of all the others,
 * each one a live copy of a credential.
 *
 * A read failure is treated as "unknown, write anyway": the write is the operation the
 * caller asked for, and skipping it because we could not compare would silently drop a
 * credential update.
 */
export async function upsertSecretIfChanged(
  saToken: string,
  project: string,
  secretId: string,
  plaintext: string,
  labels?: Record<string, string>,
): Promise<{ written: boolean }> {
  const current = await getEntraSecret(saToken, `projects/${project}/secrets/${secretId}/versions/latest`);
  if (current.ok && current.plaintext === plaintext) return { written: false };
  const result = await putEntraSecret(project, saToken, secretId, plaintext, labels);
  if (!result.ok) throw new Error(result.error ?? 'upsertSecretIfChanged failed');
  // Superseded versions are still enabled, still billed, and still readable — a stale
  // copy of a live credential serves no purpose. One prior version is kept so a bad
  // paste can be rolled back; everything older is destroyed.
  await pruneSecretVersions(saToken, project, secretId, 2);
  return { written: true };
}

/**
 * Destroy all but the newest `keep` enabled versions of a secret.
 *
 * Tools resolve `versions/latest`, so older versions back nothing — they only
 * accumulate cost and extra copies of a credential. Destroy removes the payload and
 * leaves the version metadata, which is what keeps the audit trail intact.
 *
 * Best-effort: a failure here must never fail the customer's save. The credential is
 * already written by this point, and refusing the save over a cleanup problem would
 * trade a real success for a cosmetic one.
 */
export async function pruneSecretVersions(
  saToken: string,
  project: string,
  secretId: string,
  keep = 2,
): Promise<{ destroyed: number }> {
  try {
    const res = await fetch(
      `${HOST}/projects/${project}/secrets/${secretId}/versions?filter=state:ENABLED&pageSize=100`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    if (!res.ok) return { destroyed: 0 };
    const json = (await res.json()) as { versions?: Array<{ name?: string; state?: string }> };
    const enabled = (json.versions ?? []).filter((v) => v.name && v.state === 'ENABLED');
    // The API returns newest first; guard by version number anyway rather than trusting
    // ordering, because destroying the wrong end here would destroy the live credential.
    const sorted = enabled
      .map((v) => ({ name: v.name!, num: Number(v.name!.split('/').pop()) }))
      .filter((v) => Number.isFinite(v.num))
      .sort((a, b) => b.num - a.num);
    let destroyed = 0;
    for (const v of sorted.slice(keep)) {
      const d = await fetch(`${HOST}/${v.name}:destroy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (d.ok) destroyed++;
    }
    if (destroyed) logger.info({ secretId, destroyed }, 'Secret Manager: pruned superseded versions');
    return { destroyed };
  } catch (err) {
    logger.warn({ secretId, err: (err as Error).message }, 'Secret Manager: version prune failed');
    return { destroyed: 0 };
  }
}

/**
 * Grant the Reasoning Engine runtime service agent read access to EXACTLY the secrets
 * one deployment needs, on the secrets themselves rather than on the project.
 *
 * The documented prerequisite has been a project-wide `roles/secretmanager.secretAccessor`,
 * which is the same identity for every Reasoning Engine in the project — so any deployed
 * agent could read every secret there, including other customers' connector credentials.
 * A per-secret binding narrows that to the credentials the agent was actually built with.
 *
 * Best-effort, and deliberately so: our SA needs `secretmanager.secrets.{get,set}IamPolicy`
 * on the customer's project, which many customers will not have granted. Failing here
 * must not fail the deployment — the caller reports it, exactly as
 * `ensureReasoningEngineDiscoveryAccess` does for Discovery Engine — but a caller that
 * ignores the result ships an agent whose every tool call 403s at inference behind a
 * green deploy.
 */
export async function grantSecretAccessToServiceAgent(
  saToken: string,
  project: string,
  secretIds: string[],
  serviceAgentEmail: string,
): Promise<{ granted: string[]; failed: Array<{ secretId: string; error: string }> }> {
  const granted: string[] = [];
  const failed: Array<{ secretId: string; error: string }> = [];
  const member = `serviceAccount:${serviceAgentEmail}`;
  const role = 'roles/secretmanager.secretAccessor';

  for (const secretId of new Set(secretIds)) {
    const base = `${HOST}/projects/${project}/secrets/${secretId}`;
    try {
      const getRes = await fetch(`${base}:getIamPolicy`, { headers: { Authorization: `Bearer ${saToken}` } });
      if (!getRes.ok) {
        failed.push({ secretId, error: `getIamPolicy ${getRes.status}: ${(await getRes.text()).slice(0, 160)}` });
        continue;
      }
      const policy = (await getRes.json()) as { bindings?: Array<{ role: string; members: string[] }> };
      policy.bindings = policy.bindings ?? [];
      const binding = policy.bindings.find((b) => b.role === role);
      if (binding?.members?.includes(member)) {
        granted.push(secretId);
        continue;
      }
      if (binding) binding.members.push(member);
      else policy.bindings.push({ role, members: [member] });

      const setRes = await fetch(`${base}:setIamPolicy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy }),
      });
      if (!setRes.ok) {
        failed.push({ secretId, error: `setIamPolicy ${setRes.status}: ${(await setRes.text()).slice(0, 160)}` });
        continue;
      }
      granted.push(secretId);
    } catch (err) {
      failed.push({ secretId, error: (err as Error).message });
    }
  }
  if (failed.length) {
    logger.warn({ project, failed: failed.length }, 'Secret Manager: per-secret access grant incomplete');
  }
  return { granted, failed };
}

export interface SecretOwnership {
  /** The secret exists and we could read its metadata. */
  found: boolean;
  /** `app_user` label written at save time, when present. */
  owner?: string;
  /** True when the secret carries our management label. */
  managed?: boolean;
}

/**
 * Who does a secret belong to?
 *
 * Deleting by id alone is unsafe in this product: ids written before customer scoping
 * (`studio-enterprise-atlassian-api-token`) contain no owner at all, and on a deployment
 * serving several customers that same id backs ALL of them. One customer purging Jira
 * would destroy the credential another customer's deployed agent is still reading, with
 * no way back — destroy is irreversible.
 *
 * Labels are the only owner statement attached to the secret itself, so they are what the
 * delete path checks. A secret we cannot read metadata for is reported `found: false` and
 * must be left alone rather than assumed ours.
 */
export async function getSecretOwnership(
  saToken: string,
  project: string,
  secretId: string,
): Promise<SecretOwnership> {
  try {
    const res = await fetch(`${HOST}/projects/${project}/secrets/${secretId}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (!res.ok) return { found: false };
    const json = (await res.json()) as { labels?: Record<string, string> };
    const labels = json.labels ?? {};
    return { found: true, owner: labels.app_user, managed: labels.managed_by === 'studio-enterprise' };
  } catch {
    return { found: false };
  }
}

/**
 * Permanently delete a secret and every version of it.
 *
 * The deprovisioning path: without it a departing customer's credentials stay in the
 * project forever. Irreversible, so it is only ever driven by an explicit request —
 * never by migration cleanup or a failed run.
 */
export async function deleteSecret(
  saToken: string,
  project: string,
  secretId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${HOST}/projects/${project}/secrets/${secretId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${saToken}` },
  });
  // Already gone is the outcome the caller wanted.
  if (res.ok || res.status === 404) return { ok: true };
  const text = await res.text().catch(() => '');
  logger.warn({ status: res.status, secretId }, 'Secret Manager: delete secret failed');
  return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
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
    // versionName is `projects/{project}/secrets/{id}/versions/{v}` — logging it (not just
    // the status) is what makes this line useful: without it, every 404 anywhere in the app
    // reads identically and nobody can tell which secret, in which project, was missing.
    logger.warn({ status: res.status, versionName, detail: text.slice(0, 200) }, 'Secret Manager: access version failed');
    return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
  }
  const json = (await res.json()) as { payload?: { data?: string } };
  if (!json.payload?.data) return { ok: false, error: 'access succeeded but returned no payload' };
  return { ok: true, plaintext: Buffer.from(json.payload.data, 'base64').toString('utf8') };
}
