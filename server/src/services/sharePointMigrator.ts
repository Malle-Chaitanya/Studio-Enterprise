/**
 * SharePoint knowledge migration — crawl a site/folder and index its documents into a
 * Discovery Engine data store, using Microsoft Graph.
 *
 * WHY GRAPH AND NOT GOOGLE'S SHAREPOINT CONNECTOR: that connector authenticates against
 * SharePoint's own REST API, which accepts app-only tokens ONLY when they were minted
 * with a certificate (`appidacr: 2`). A client secret produces `appidacr: 1` and every
 * call returns `401 Unsupported app only token`, regardless of which SharePoint
 * permissions are granted — verified live 2026-08-07, and it is why the two existing
 * connectors in this project sit at 0 documents with "invalid credentials". Graph
 * accepts secret-based app-only tokens, so the same customer credentials that fail the
 * connector work here.
 *
 * WHY RAW BYTES AND NOT EXTRACTED TEXT: we upload each file to GCS untouched and let
 * Discovery Engine parse it. Its layout parser handles PDF/Word/Excel and annotates
 * tables and images with an LLM — materially better than anything we would extract
 * ourselves, and it keeps the parser out of our dependency tree.
 *
 * Scope: read-only against SharePoint. Nothing is written back.
 *
 * ⚠️ Stores created here are `aclEnabled: false` — SharePoint per-file permissions are
 * NOT preserved, so anyone who can reach the agent can read everything indexed. That is
 * a fidelity/permission fact the caller must report, not hide.
 */

import { logger } from '../logger.js';
import { createDataStore, importDocumentsFromGcs, awaitImport, dataStoreResourcePath } from './geminiDataStore.js';
import { ensureBucket, uploadBytesToGcs, grantDeServiceAgentBucketAccess } from './gcsUpload.js';
import { sanitizeDataStoreId } from './knowledgePlanner.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_FILES = 500;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const GRAPH_TIMEOUT_MS = 30_000;

/** Extensions Discovery Engine can parse. Anything else is skipped and reported. */
const INDEXABLE = /\.(pdf|docx?|pptx?|xlsx?|txt|md|csv|html?|json|xml|rtf)$/i;

export interface SharePointCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The site or folder URL the source agent named, e.g.
   *  https://contoso.sharepoint.com/Shared%20Documents/Policies */
  siteUrl: string;
}

export interface SharePointMigrationResult {
  dataStoreId?: string;
  resourcePath?: string;
  fileCount: number;
  skipped: Array<{ name: string; reason: string }>;
  error?: string;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: unknown;
  file?: unknown;
  webUrl?: string;
  lastModifiedDateTime?: string;
}

async function graphToken(creds: SharePointCreds): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) throw new Error(`Graph token failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Graph GET ${path} failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a SharePoint URL into a Graph site id plus the folder path inside its default
 * drive. Copilot Studio stores the human URL, which Graph cannot address directly.
 */
export async function resolveSiteAndFolder(
  siteUrl: string,
  token: string,
): Promise<{ siteId: string; folderPath: string }> {
  const url = new URL(siteUrl);
  const host = url.hostname;
  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));

  let sitePath = '';
  let rest = segments;
  if (segments[0]?.toLowerCase() === 'sites' && segments.length >= 2) {
    sitePath = `/sites/${segments[1]}`;
    rest = segments.slice(2);
  }
  const site = await graphGet<{ id: string }>(
    sitePath ? `/sites/${host}:${sitePath}` : `/sites/${host}`,
    token,
  );
  // Drop the document-library segment; what remains addresses a folder in the drive.
  if (rest[0] && /^(shared documents|documents)$/i.test(rest[0])) rest = rest.slice(1);
  return { siteId: site.id, folderPath: rest.join('/') };
}

/** Depth-first listing of every file under the folder, bounded by MAX_FILES. */
async function listFilesRecursive(
  siteId: string,
  folderPath: string,
  token: string,
): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  const queue: string[] = [folderPath];

  while (queue.length && out.length < MAX_FILES) {
    const path = queue.shift()!;
    const url = path
      ? `/sites/${siteId}/drive/root:/${encodeURI(path)}:/children?$top=200`
      : `/sites/${siteId}/drive/root/children?$top=200`;
    let page: { value: DriveItem[]; '@odata.nextLink'?: string };
    try {
      page = await graphGet(url, token);
    } catch (err) {
      logger.warn({ path, err: (err as Error).message }, 'sharePointMigrator: listing failed for folder');
      continue;
    }
    for (const item of page.value ?? []) {
      if (item.folder) queue.push(path ? `${path}/${item.name}` : item.name);
      else if (item.file) out.push({ ...item, name: path ? `${path}/${item.name}` : item.name });
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

/** Discovery Engine parses by MIME type, so a wrong type silently yields no text. */
function mimeTypeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    html: 'text/html', htm: 'text/html', json: 'application/json',
    xml: 'application/xml', rtf: 'application/rtf',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function downloadItem(siteId: string, itemPath: string, token: string): Promise<Buffer> {
  const res = await fetch(`${GRAPH}/sites/${siteId}/drive/root:/${encodeURI(itemPath)}:/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Crawl `creds.siteUrl` and index every parseable document into a data store.
 * Idempotent: the data store id is derived from `agentSourceId`, and the import runs
 * INCREMENTAL, so re-running refreshes content in place rather than duplicating it —
 * which is also how updated files reach an already-deployed agent without a redeploy.
 */
export async function migrateSharePointToDataStore(
  project: string,
  saToken: string,
  agentSourceId: string,
  creds: SharePointCreds,
  opts?: { gcsProject?: string; gcsToken?: string },
): Promise<SharePointMigrationResult> {
  const gcsProject = opts?.gcsProject ?? project;
  const gcsToken = opts?.gcsToken ?? saToken;
  const skipped: Array<{ name: string; reason: string }> = [];

  let token: string;
  try {
    token = await graphToken(creds);
  } catch (err) {
    return { fileCount: 0, skipped, error: (err as Error).message };
  }

  // ── 1. Resolve the URL and list files ──────────────────────────────────────
  let siteId: string;
  let folderPath: string;
  try {
    ({ siteId, folderPath } = await resolveSiteAndFolder(creds.siteUrl, token));
  } catch (err) {
    return { fileCount: 0, skipped, error: `could not resolve ${creds.siteUrl}: ${(err as Error).message}` };
  }
  logger.info({ siteId, folderPath }, 'sharePointMigrator: resolved site');

  const files = await listFilesRecursive(siteId, folderPath, token);
  if (files.length === 0) {
    return { fileCount: 0, skipped, error: `no files found under ${creds.siteUrl}` };
  }

  // ── 2. Create the data store ───────────────────────────────────────────────
  const dataStoreId = sanitizeDataStoreId(`${agentSourceId}-sharepoint`);
  const created = await createDataStore(project, saToken, {
    dataStoreId,
    displayName: 'SharePoint Knowledge',
    kind: 'document',
  });
  if (created.error && !created.alreadyExists) {
    return { fileCount: 0, skipped, error: `data store create: ${created.error}` };
  }

  // Layout parsing with table + image annotation, matching what Google's own connector
  // configures. Without this a store defaults to plain digital parsing: no layout, and
  // images contribute nothing at all.
  await configureLayoutParsing(project, saToken, dataStoreId);

  // ── 3. Copy each file to GCS, untouched ────────────────────────────────────
  const bucket = (process.env.ADK_STAGING_BUCKET || `${gcsProject}-adk-staging`).replace(/^gs:\/\//, '');
  const bucketReady = await ensureBucket(gcsToken, gcsProject, bucket);
  if (!bucketReady.ok) return { fileCount: 0, skipped, error: `GCS bucket: ${bucketReady.error}` };
  await grantDeServiceAgentBucketAccess(saToken, project, bucket);

  const gcsUris: string[] = [];
  for (const f of files) {
    if (!INDEXABLE.test(f.name)) {
      skipped.push({ name: f.name, reason: 'file type not parseable by Discovery Engine' });
      continue;
    }
    if ((f.size ?? 0) > MAX_FILE_BYTES) {
      skipped.push({ name: f.name, reason: `${f.size} bytes exceeds the ${MAX_FILE_BYTES} byte limit` });
      continue;
    }
    try {
      const bytes = await downloadItem(siteId, f.name, token);
      const objectName = `sharepoint/${dataStoreId}/${f.name.replace(/[^A-Za-z0-9._/-]/g, '_')}`;
      const up = await uploadBytesToGcs(gcsToken, bucket, objectName, bytes, mimeTypeFor(f.name));
      if (!up.ok || !up.gcsUri) {
        skipped.push({ name: f.name, reason: `GCS upload failed: ${up.error ?? 'unknown'}` });
        continue;
      }
      gcsUris.push(up.gcsUri);
    } catch (err) {
      skipped.push({ name: f.name, reason: `download/upload failed: ${(err as Error).message}` });
    }
  }

  if (gcsUris.length === 0) {
    return { dataStoreId, fileCount: 0, skipped, error: 'no indexable files were copied' };
  }

  // ── 4. Import ──────────────────────────────────────────────────────────────
  const imp = await importDocumentsFromGcs(project, saToken, dataStoreId, gcsUris);
  if (!imp.started || !imp.operationName) {
    return { dataStoreId, fileCount: gcsUris.length, skipped, error: imp.error ?? 'import did not start' };
  }
  const recon = await awaitImport(saToken, imp.operationName, gcsUris.length);
  // Deliberately NOT treating succeeded===0 as failure: the operation's counters lag
  // behind the documents actually landing, and confluenceMigrator discarding a perfectly
  // good data store on that signal is a bug we already hit once.
  logger.info({ dataStoreId, requested: gcsUris.length, succeeded: recon.succeeded }, 'sharePointMigrator: import complete');

  return {
    dataStoreId,
    resourcePath: dataStoreResourcePath(project, dataStoreId),
    fileCount: gcsUris.length,
    skipped,
  };
}

/**
 * Turn on layout parsing with table and image annotation for a data store.
 * Best-effort: a store that keeps the default digital parser still indexes text, so a
 * failure here degrades quality rather than breaking the migration.
 */
export async function configureLayoutParsing(
  project: string,
  saToken: string,
  dataStoreId: string,
): Promise<boolean> {
  const url =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global` +
    `/collections/default_collection/dataStores/${dataStoreId}/documentProcessingConfig`;
  try {
    // No updateMask: unlike every other Discovery Engine PATCH, this endpoint REJECTS
    // one — `400 Field "updateMask" is unsupported`. Sending it silently left stores on
    // the default digital parser (no layout, no image/table annotation) while the
    // migration reported success, because this call is best-effort.
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      // chunkingConfig is deliberately omitted: it is only honoured when set before a
      // store has ingested anything, so sending it here would either be ignored or
      // rejected. Layout parsing, which IS settable, is the part that matters for
      // PDFs/Office/images.
      body: JSON.stringify({
        defaultParsingConfig: {
          layoutParsingConfig: { enableTableAnnotation: true, enableImageAnnotation: true },
        },
      }),
    });
    if (!res.ok) {
      logger.warn({ dataStoreId, status: res.status }, 'sharePointMigrator: layout parsing config not applied');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ dataStoreId, err: (err as Error).message }, 'sharePointMigrator: layout parsing config failed');
    return false;
  }
}
