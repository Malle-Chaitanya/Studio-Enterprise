import { logger } from '../logger.js';

/**
 * Plain-REST Google Cloud Storage upload — no `@google-cloud/storage`
 * dependency, same convention as secretManager.ts (reuses the SA's existing
 * `cloud-platform` scope, no new npm package).
 *
 * Used to stage a locally-uploaded knowledge file's bytes in GCS before
 * Discovery Engine's `documents:import` (which only reads from GCS/BigQuery,
 * never accepts inline bytes for unstructured content) can index it — see
 * knowledgeDataStoreExecutor.migrateFileToDocumentStore.
 */

export interface GcsUploadResult {
  ok: boolean;
  gcsUri?: string;
  error?: string;
}

/**
 * Look up a GCP project's numeric project number via the Resource Manager API.
 * Needed to construct the Discovery Engine service-agent email
 * (`service-{number}@gcp-sa-discoveryengine.iam.gserviceaccount.com`).
 */
async function getProjectNumber(saToken: string, project: string): Promise<string | null> {
  try {
    const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json() as { projectNumber?: string };
    return json.projectNumber ?? null;
  } catch {
    return null;
  }
}

/**
 * Grant the Discovery Engine service agent `roles/storage.objectViewer` on the
 * bucket so that `documents:import` (which runs as DE's own service agent, not
 * the SA that uploaded the files) can read the staged objects.
 *
 * Idempotent — skips silently if the grant already exists. Best-effort — logs
 * a warning but never throws, so a failed grant doesn't abort the upload.
 */
/**
 * Grant DE service agent objectViewer using a pre-resolved project number.
 * Use this when the caller already knows the numeric project number (e.g. from
 * a prior resolve call, or hardcoded for a known project) to avoid a separate
 * Resource Manager API call with potentially limited credentials.
 */
export async function grantDeServiceAgentBucketAccessByNumber(
  bucketToken: string,
  projectNumber: string,
  bucket: string,
): Promise<void> {
  const member = `serviceAccount:service-${projectNumber}@gcp-sa-discoveryengine.iam.gserviceaccount.com`;
  const viewerRole = 'roles/storage.objectViewer';

  const getRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/iam`, {
    headers: { Authorization: `Bearer ${bucketToken}` },
  });
  if (!getRes.ok) {
    logger.warn({ bucket, status: getRes.status }, 'gcsUpload: could not read bucket IAM; skipping DE service agent grant');
    return;
  }

  const policy = await getRes.json() as {
    version?: number;
    bindings?: Array<{ role: string; members: string[] }>;
    etag?: string;
  };
  const bindings: Array<{ role: string; members: string[] }> = policy.bindings ?? [];
  const existing = bindings.find((b) => b.role === viewerRole);
  if (existing) {
    if (existing.members.includes(member)) return;
    existing.members.push(member);
  } else {
    bindings.push({ role: viewerRole, members: [member] });
  }

  const setRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/iam`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${bucketToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...policy, bindings }),
  });
  if (!setRes.ok) {
    const text = await setRes.text().catch(() => '');
    logger.warn({ bucket, status: setRes.status, body: text.slice(0, 200) }, 'gcsUpload: DE service agent bucket grant failed (non-fatal)');
  }
}

export async function grantDeServiceAgentBucketAccess(saToken: string, project: string, bucket: string): Promise<void> {
  const projectNumber = await getProjectNumber(saToken, project);
  if (!projectNumber) {
    logger.warn({ project }, 'gcsUpload: could not resolve project number; skipping Discovery Engine service agent bucket grant');
    return;
  }

  const member = `serviceAccount:service-${projectNumber}@gcp-sa-discoveryengine.iam.gserviceaccount.com`;
  const viewerRole = 'roles/storage.objectViewer';

  const getRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/iam`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!getRes.ok) {
    logger.warn({ bucket, status: getRes.status }, 'gcsUpload: could not read bucket IAM; skipping DE service agent grant');
    return;
  }

  const policy = await getRes.json() as {
    version?: number;
    bindings?: Array<{ role: string; members: string[] }>;
    etag?: string;
  };
  const bindings: Array<{ role: string; members: string[] }> = policy.bindings ?? [];

  const existing = bindings.find((b) => b.role === viewerRole);
  if (existing) {
    if (existing.members.includes(member)) return; // already granted
    existing.members.push(member);
  } else {
    bindings.push({ role: viewerRole, members: [member] });
  }

  const setRes = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/iam`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...policy, bindings }),
  });
  if (!setRes.ok) {
    const text = await setRes.text().catch(() => '');
    logger.warn({ bucket, status: setRes.status, body: text.slice(0, 200) }, 'gcsUpload: Discovery Engine service agent bucket grant failed (non-fatal)');
  }
}

/**
 * Ensure a GCS bucket exists and the Discovery Engine service agent can read
 * from it (needed for `documents:import` which runs as DE's own service agent).
 * Idempotent — safe to call before every upload run.
 */
export async function ensureBucket(
  saToken: string,
  project: string,
  bucket: string,
  location = 'us-central1',
): Promise<{ ok: boolean; error?: string }> {
  const check = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });

  if (check.ok) {
    // Bucket already exists — still ensure DE service agent has objectViewer (idempotent).
    await grantDeServiceAgentBucketAccess(saToken, project, bucket).catch(() => {});
    return { ok: true };
  }

  const create = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: bucket, location }),
  });

  if (!create.ok) {
    const text = await create.text();
    if (create.status === 409 || text.includes('already exists')) {
      await grantDeServiceAgentBucketAccess(saToken, project, bucket).catch(() => {});
      return { ok: true };
    }
    return { ok: false, error: `${create.status}: ${text.slice(0, 200)}` };
  }

  // Newly created — grant DE service agent access.
  await grantDeServiceAgentBucketAccess(saToken, project, bucket).catch(() => {});
  return { ok: true };
}

/** Upload raw bytes to `gs://{bucket}/{objectName}` via the simple (non-resumable) media upload endpoint. */
export async function uploadBytesToGcs(
  saToken: string,
  bucket: string,
  objectName: string,
  bytes: Buffer,
  mimeType: string,
): Promise<GcsUploadResult> {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': mimeType },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ status: res.status, bucket, objectName }, 'GCS upload failed');
    return { ok: false, error: `${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true, gcsUri: `gs://${bucket}/${objectName}` };
}
