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

/** Ensure a bucket exists (idempotent) — the ADK staging bucket is usually already present from a deploy. */
export async function ensureBucket(saToken: string, project: string, bucket: string, location = 'us-central1'): Promise<{ ok: boolean; error?: string }> {
  const check = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (check.ok) return { ok: true };
  const create = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: bucket, location }),
  });
  if (!create.ok) {
    const text = await create.text();
    if (create.status === 409 || text.includes('already exists')) return { ok: true };
    return { ok: false, error: `${create.status}: ${text.slice(0, 200)}` };
  }
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
