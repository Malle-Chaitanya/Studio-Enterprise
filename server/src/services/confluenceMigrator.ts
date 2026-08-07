/**
 * Confluence knowledge migration service.
 *
 * Crawls ONLY the Confluence spaces that the agent author selected in Copilot
 * Studio (stored as space display names in KnowledgeSourceIR.confluenceSpaceNames).
 *
 * Strategy: resolve space display names → space keys via the spaces list API,
 * then fetch pages directly per space key (paginated). This is more reliable than
 * CQL `space.title in (...)` which varies across Confluence versions, and avoids
 * the `status=current` CQL field that some instances reject.
 *
 * Auth: Atlassian Basic auth — base64(email:api_token).
 * Scope: read-only (GET only). No content is written back to Confluence.
 */

import { logger } from '../logger.js';
import { createDataStore, importDocumentsFromGcs, awaitImport, dataStoreResourcePath } from './geminiDataStore.js';
import { ensureBucket, uploadBytesToGcs, grantDeServiceAgentBucketAccess, grantDeServiceAgentBucketAccessByNumber } from './gcsUpload.js';
import { sanitizeDataStoreId } from './knowledgePlanner.js';
import { uploadAgentFile, updateAgentFiles, getAgent, readAgentFiles } from './geminiAgentFiles.js';
import type { GeminiDestination } from '../types.js';

const MAX_PAGES_TOTAL = 500;
const CONFLUENCE_API_TIMEOUT_MS = 20_000;

export interface ConfluenceCreds {
  base_url: string;   // e.g. https://yourcompany.atlassian.net
  email: string;
  api_token: string;
  /** Space display names extracted from Copilot Studio (e.g. ["Engineering", "Demo Company Wiki"]). */
  spaceNames?: string[];
}

interface ConfluenceSpace {
  key: string;
  name: string;
}

interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  spaceName: string;
  htmlBody: string;
}

export interface ConfluenceMigrationResult {
  dataStoreId?: string;
  resourcePath?: string;
  pageCount: number;
  spaceCount: number;
  error?: string;
}

function basicAuth(email: string, apiToken: string): string {
  return 'Basic ' + Buffer.from(`${email}:${apiToken}`, 'utf-8').toString('base64');
}

async function confluenceFetch(url: string, auth: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFLUENCE_API_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch all Confluence spaces the API user can see, resolve the requested
 * display names to their space keys (case-insensitive match).
 */
async function resolveSpaceKeys(
  creds: ConfluenceCreds,
  targetNames: string[],
): Promise<{ spaces: ConfluenceSpace[]; listError?: string }> {
  const auth = basicAuth(creds.email, creds.api_token);
  const normalizedTargets = new Map(targetNames.map((n) => [n.toLowerCase().trim(), n]));
  const matched: ConfluenceSpace[] = [];
  let listError: string | undefined;

  let start = 0;
  const limit = 50;

  while (true) {
    const url = `${creds.base_url}/wiki/rest/api/space?limit=${limit}&start=${start}&type=global`;
    const res = await confluenceFetch(url, auth);
    if (!res.ok) {
      // A failed LISTING is not "the space does not exist". Swallowing it and reporting
      // "none of the requested spaces found — check space names" sent us looking for a
      // naming bug when the real answer was
      //   403 "Request rejected because caller cannot access Confluence"
      // i.e. the Atlassian account has no Confluence access on that site at all
      // (live 2026-08-07). Carry the real status up.
      const body = await res.text().catch(() => '');
      listError =
        res.status === 403
          ? `Atlassian returned 403 listing spaces — the account ${creds.email} cannot access Confluence at ${creds.base_url}. ` +
            'Grant that account Confluence access (a Jira-only licence is not enough), or use an account that has it.'
          : res.status === 401
            ? `Atlassian returned 401 listing spaces — the email/API token pair was rejected for ${creds.base_url}.`
            : `Atlassian returned ${res.status} listing spaces: ${body.slice(0, 200)}`;
      logger.warn({ status: res.status, base: creds.base_url }, 'confluenceMigrator: spaces list failed');
      break;
    }
    const json = await res.json() as {
      results?: Array<{ key: string; name: string }>;
      size?: number;
      limit?: number;
      start?: number;
    };
    const results = json.results ?? [];
    for (const s of results) {
      if (normalizedTargets.has(s.name.toLowerCase().trim())) {
        matched.push({ key: s.key, name: s.name });
      }
    }
    // Stop when we've matched all targets or run out of pages
    if (matched.length >= targetNames.length || results.length < limit) break;
    start += results.length;
  }

  return { spaces: matched, listError };
}

/**
 * Fetch all pages in a space by key — paginated, with body.view expanded.
 * Uses the direct space content API (not CQL) for reliability across versions.
 */
async function fetchPagesInSpace(
  creds: ConfluenceCreds,
  space: ConfluenceSpace,
  maxPages: number,
): Promise<ConfluencePage[]> {
  const auth = basicAuth(creds.email, creds.api_token);
  const pages: ConfluencePage[] = [];
  let start = 0;
  const limit = 50;

  while (pages.length < maxPages) {
    const url =
      `${creds.base_url}/wiki/rest/api/space/${encodeURIComponent(space.key)}/content/page` +
      `?limit=${limit}&start=${start}&expand=body.view`;
    const res = await confluenceFetch(url, auth);
    if (!res.ok) {
      logger.warn({ spaceKey: space.key, status: res.status }, 'confluenceMigrator: page fetch failed');
      break;
    }
    const json = await res.json() as {
      results?: Array<{
        id: string;
        title: string;
        body?: { view?: { value?: string } };
      }>;
      size?: number;
    };
    const results = json.results ?? [];
    for (const p of results) {
      pages.push({
        id: p.id,
        title: p.title,
        spaceKey: space.key,
        spaceName: space.name,
        htmlBody: p.body?.view?.value ?? '',
      });
    }
    if (results.length < limit) break;
    start += results.length;
  }

  return pages;
}

function pageToHtml(page: ConfluencePage, baseUrl: string): Buffer {
  const escaped = page.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapedSpace = page.spaceName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const canonical = `${baseUrl}/wiki/spaces/${encodeURIComponent(page.spaceKey)}/pages/${page.id}`;
  const html = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `  <meta charset="utf-8">`,
    `  <meta name="source" content="confluence">`,
    `  <meta name="space-name" content="${escapedSpace}">`,
    `  <meta name="space-key" content="${page.spaceKey}">`,
    `  <meta name="page-id" content="${page.id}">`,
    `  <link rel="canonical" href="${canonical}">`,
    `  <title>${escaped}</title>`,
    '</head>',
    '<body>',
    `<h1>${escaped}</h1>`,
    page.htmlBody,
    '</body>',
    '</html>',
  ].join('\n');
  return Buffer.from(html, 'utf-8');
}

/**
 * Crawl ONLY the Confluence spaces the agent author selected (via `spaceNames`),
 * upload pages to GCS, import into a Gemini document data store.
 *
 * `agentSourceId` drives the data store ID so each agent gets its own store
 * and re-runs are idempotent (same store id → incremental upsert by document).
 *
 * When the GCS bucket must live in a different project than the Discovery Engine
 * data store (e.g. customer's DE project ≠ SA's GCS project), pass `gcsToken`
 * and `gcsProject` separately. Both default to `saToken`/`project` when omitted.
 */
export async function migrateConfluenceToDataStore(
  project: string,
  saToken: string,
  agentSourceId: string,
  creds: ConfluenceCreds,
  opts?: {
    gcsToken?: string;
    gcsProject?: string;
    /** Numeric project number for the DE data store's project.
     *  Required when gcsProject ≠ project so the cross-project
     *  DE service agent grant can be applied without a Resource Manager call. */
    deProjectNumber?: string;
  },
): Promise<ConfluenceMigrationResult> {
  const gcsToken   = opts?.gcsToken   ?? saToken;
  const gcsProject = opts?.gcsProject ?? project;
  const targetNames = creds.spaceNames ?? [];
  if (targetNames.length === 0) {
    return { pageCount: 0, spaceCount: 0, error: 'No Confluence space names provided — cannot determine which spaces to crawl.' };
  }

  logger.info({ targetNames }, 'confluenceMigrator: resolving space names to keys');

  // ── 1. Resolve space names → keys ────────────────────────────────────────
  const { spaces: resolvedSpaces, listError } = await resolveSpaceKeys(creds, targetNames);
  if (resolvedSpaces.length === 0) {
    return {
      pageCount: 0,
      spaceCount: 0,
      // Report the ACCESS failure when there was one — "space not found" is only true
      // when the listing actually succeeded and the name was absent from it.
      error:
        listError ??
        `None of the requested spaces found: ${targetNames.join(', ')}. The space list was read successfully, so these names do not match any space on ${creds.base_url}.`,
    };
  }

  const unmatchedNames = targetNames.filter(
    (n) => !resolvedSpaces.some((s) => s.name.toLowerCase().trim() === n.toLowerCase().trim()),
  );
  if (unmatchedNames.length > 0) {
    logger.warn({ unmatchedNames }, 'confluenceMigrator: some requested spaces not found — crawling matched ones only');
  }

  logger.info({ resolvedSpaces, unmatchedNames }, 'confluenceMigrator: space resolution complete');

  // ── 2. Fetch pages from each resolved space ───────────────────────────────
  const perSpaceMax = Math.ceil(MAX_PAGES_TOTAL / resolvedSpaces.length);
  const allPages: ConfluencePage[] = [];
  for (const space of resolvedSpaces) {
    const pages = await fetchPagesInSpace(creds, space, perSpaceMax);
    logger.info({ spaceKey: space.key, spaceName: space.name, pages: pages.length }, 'confluenceMigrator: fetched pages');
    allPages.push(...pages);
    if (allPages.length >= MAX_PAGES_TOTAL) break;
  }

  if (allPages.length === 0) {
    return {
      pageCount: 0,
      spaceCount: resolvedSpaces.length,
      error: `No pages found in matched spaces: ${resolvedSpaces.map((s) => s.name).join(', ')}.`,
    };
  }

  // ── 3. Create the document data store ────────────────────────────────────
  const dataStoreId = sanitizeDataStoreId(`${agentSourceId}-confluence`);
  const created = await createDataStore(project, saToken, {
    dataStoreId,
    displayName: 'Confluence Knowledge',
    kind: 'document',
  });
  if (created.error && !created.alreadyExists) {
    return { pageCount: allPages.length, spaceCount: resolvedSpaces.length, error: `Data store create: ${created.error}` };
  }

  // ── 4. Upload pages to GCS ────────────────────────────────────────────────
  // Use gcsToken/gcsProject (may differ from saToken/project when the DE data
  // store is in a customer project but the bucket lives in the SA's project).
  const bucket = (process.env.ADK_STAGING_BUCKET || `${gcsProject}-adk-staging`).replace(/^gs:\/\//, '');
  const bucketReady = await ensureBucket(gcsToken, gcsProject, bucket);
  if (!bucketReady.ok) {
    return { pageCount: allPages.length, spaceCount: resolvedSpaces.length, error: `GCS bucket: ${bucketReady.error}` };
  }

  // When GCS bucket is in a different project than the DE data store, the DE
  // service agent for `project` also needs objectViewer on the bucket so that
  // documents:import (which runs as DE's service agent) can read across projects.
  if (gcsProject !== project) {
    if (opts?.deProjectNumber) {
      // Fast path: use pre-resolved project number (avoids Resource Manager call
      // which may fail if gcsToken lacks resourcemanager.projects.get on deProject).
      await grantDeServiceAgentBucketAccessByNumber(gcsToken, opts.deProjectNumber, bucket).catch(() => {});
    } else {
      // Slow path: resolve project number via Resource Manager (requires saToken to
      // have resourcemanager.projects.get on `project`).
      await grantDeServiceAgentBucketAccess(gcsToken, project, bucket).catch(() => {});
    }
  }

  const gcsUris: string[] = [];
  let uploadFailed = 0;
  for (const page of allPages) {
    const html = pageToHtml(page, creds.base_url);
    const safeName = page.spaceKey.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 40);
    const objectName = `knowledge-files/${agentSourceId}/confluence/${safeName}-${page.id}.html`;
    const up = await uploadBytesToGcs(gcsToken, bucket, objectName, html, 'text/html');
    if (up.ok && up.gcsUri) {
      gcsUris.push(up.gcsUri);
    } else {
      uploadFailed++;
      logger.warn({ pageId: page.id, spaceName: page.spaceName, error: up.error }, 'confluenceMigrator: GCS upload failed for page');
    }
  }

  if (gcsUris.length === 0) {
    return { pageCount: allPages.length, spaceCount: resolvedSpaces.length, error: 'All GCS uploads failed' };
  }

  // ── 5. Import from GCS into the data store ───────────────────────────────
  const imp = await importDocumentsFromGcs(project, saToken, dataStoreId, gcsUris);
  if (!imp.started || !imp.operationName) {
    return {
      pageCount: allPages.length,
      spaceCount: resolvedSpaces.length,
      error: imp.error ?? 'Discovery Engine import did not start',
    };
  }

  const recon = await awaitImport(saToken, imp.operationName, gcsUris.length, {
    // Verify against the store: the operation's counters lag, and treating that as
    // failure once discarded a data store holding every document.
    verifyIn: { project, dataStoreId },
  });
  if (recon.succeeded === 0) {
    return {
      pageCount: allPages.length,
      spaceCount: resolvedSpaces.length,
      error: 'Import completed but 0 pages were indexed',
    };
  }

  const resourcePath = dataStoreResourcePath(project, dataStoreId);
  logger.info(
    { dataStoreId, pages: recon.succeeded, spaces: resolvedSpaces.length, uploadFailed, unmatchedNames },
    'confluenceMigrator: migration complete',
  );

  return {
    dataStoreId,
    resourcePath,
    pageCount: recon.succeeded,
    spaceCount: resolvedSpaces.length,
  };
}

export interface ConfluenceAgentFilesResult {
  uploaded: number;
  skipped: number;
  spaceCount: number;
  error?: string;
}

/**
 * Crawl Confluence spaces and upload pages as agent files (the correct low-code
 * agent knowledge mechanism — `agentFiles[]` in `lowCodeAgentDefinition`, same
 * as manually-uploaded PDFs). This is distinct from `migrateConfluenceToDataStore`
 * which targets the engine-level Discovery Engine search index.
 *
 * Idempotent: existing files with the same name are skipped (not re-uploaded).
 * Rate-limited via geminiWriteLimiter inside uploadAgentFile.
 */
export async function uploadConfluencePagesToAgent(
  dest: GeminiDestination,
  saToken: string,
  agentId: string,
  creds: ConfluenceCreds,
): Promise<ConfluenceAgentFilesResult> {
  const targetNames = creds.spaceNames ?? [];
  if (targetNames.length === 0) {
    return { uploaded: 0, skipped: 0, spaceCount: 0, error: 'No space names provided' };
  }

  // ── 1. Resolve space names → keys ──────────────────────────────────────────
  const { spaces: resolvedSpaces, listError: listErr } = await resolveSpaceKeys(creds, targetNames);
  if (resolvedSpaces.length === 0) {
    return {
      uploaded: 0,
      skipped: 0,
      spaceCount: 0,
      error: listErr ?? `No spaces matched: ${targetNames.join(', ')}`,
    };
  }

  // ── 2. Fetch pages from each space ─────────────────────────────────────────
  const perSpaceMax = Math.ceil(MAX_PAGES_TOTAL / resolvedSpaces.length);
  const allPages: ConfluencePage[] = [];
  for (const space of resolvedSpaces) {
    const pages = await fetchPagesInSpace(creds, space, perSpaceMax);
    allPages.push(...pages);
    if (allPages.length >= MAX_PAGES_TOTAL) break;
  }

  if (allPages.length === 0) {
    return { uploaded: 0, skipped: 0, spaceCount: resolvedSpaces.length, error: 'No pages found in matched spaces' };
  }

  // ── 3. Read existing agent files to avoid duplicates ───────────────────────
  const existing = await getAgent(dest, saToken, agentId);
  const existingFiles = readAgentFiles(existing);
  const existingNames = new Set(existingFiles.map((f) => decodeURIComponent(f.fileName)));

  // ── 4. Upload new pages as HTML agent files ─────────────────────────────────
  const allFiles = [...existingFiles];
  let uploaded = 0;
  let skipped = 0;

  for (const page of allPages) {
    const fileName = `${page.spaceKey}-${page.id}-${page.title.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.html`;
    if (existingNames.has(fileName)) { skipped++; continue; }

    const bytes = pageToHtml(page, creds.base_url);
    const up = await uploadAgentFile(dest, saToken, agentId, { fileName, mimeType: 'text/html', bytes });
    if (!up.ok) {
      logger.warn({ pageId: page.id, fileName, error: up.error }, 'confluenceMigrator: agent file upload failed');
      continue;
    }
    // Finalize response wraps the resource: { agentFile: { name, fileName, mimeType } }
    const raw = up.raw as { agentFile?: { name?: string } } | undefined;
    if (raw?.agentFile?.name) {
      allFiles.push({ name: raw.agentFile.name, fileName, mimeType: 'text/html' });
      uploaded++;
    }
  }

  // ── 5. Commit the updated file list to the agent ───────────────────────────
  if (uploaded > 0) {
    const patch = await updateAgentFiles(dest, saToken, agentId, allFiles);
    if (!patch.ok) {
      return { uploaded, skipped, spaceCount: resolvedSpaces.length, error: `updateAgentFiles: ${patch.error}` };
    }
  }

  logger.info({ agentId, uploaded, skipped, spaces: resolvedSpaces.length }, 'confluenceMigrator: agent files upload complete');
  return { uploaded, skipped, spaceCount: resolvedSpaces.length };
}
