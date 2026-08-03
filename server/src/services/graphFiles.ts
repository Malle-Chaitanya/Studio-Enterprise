import { logger } from '../logger.js';

/**
 * Microsoft Graph file resolution/download for SharePoint/OneDrive knowledge
 * sources that Copilot Studio's "upload and sync" file-picker cannot be
 * auto-discovered for. Copilot Studio stores only an opaque
 * `skillConfiguration` reference for these — the Dataverse table that maps it
 * to a real file (`unstructuredfilesearchrecord`, confirmed via Microsoft's
 * own table docs to hold FileId/FileName/CitationLink) is excluded from the
 * security-role privilege system entirely, confirmed against a live tenant
 * (not even listed as an assignable privilege for System Administrator with
 * every table shown). See .claude/memory/decisions.md.
 *
 * This module fetches a file two ways:
 *   - resolveShareUrl: given the "Knowledge URL" a human copies from Copilot
 *     Studio's own Knowledge Details screen (the manual fallback).
 *   - searchOneDriveForFile / searchSharePointSiteForFile (graphSearch.ts):
 *     given just a filename, scoped to a known user or site (the
 *     search-and-confirm path — reduces the manual step to "confirm a
 *     match" instead of "copy a whole URL").
 *
 * Both paths reuse the SAME app-only token this tool already uses for
 * Dataverse (clientCredsToken against the Graph resource) — no new auth
 * surface. Verified live: resolveShareUrl + downloadDriveItemBytes
 * successfully pulled a real file's bytes from OneDrive with zero additional
 * permission grant.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface DriveItemRef {
  driveId: string;
  itemId: string;
  name: string;
  sizeBytes?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  /** Human-readable location for disambiguation in a candidate list (site/library name or "OneDrive"). */
  parentContext?: string;
}

/** Encode a sharing URL into Graph's "shares/{id}" identifier. */
export function encodeShareId(url: string): string {
  const b64 = Buffer.from(url.trim(), 'utf8').toString('base64');
  const b64url = b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `u!${b64url}`;
}

interface RawDriveItem {
  id?: string;
  name?: string;
  size?: number;
  file?: unknown;
  folder?: { childCount?: number };
  webUrl?: string;
  lastModifiedDateTime?: string;
  parentReference?: { driveId?: string; name?: string };
}

function toRef(item: RawDriveItem, fallbackContext?: string): DriveItemRef | null {
  if (!item.id || !item.parentReference?.driveId || !item.file) return null;
  return {
    driveId: item.parentReference.driveId,
    itemId: item.id,
    name: item.name ?? 'file',
    sizeBytes: item.size,
    webUrl: item.webUrl,
    lastModifiedDateTime: item.lastModifiedDateTime,
    parentContext: item.parentReference.name ?? fallbackContext,
  };
}

/** Resolve a SharePoint/OneDrive sharing URL to its driveItem via Graph. Returns null for folders — see resolveShareUrlSmart for the folder-aware version. */
export async function resolveShareUrl(graphToken: string, url: string): Promise<DriveItemRef | null> {
  const shareId = encodeShareId(url);
  const res = await fetch(
    `${GRAPH}/shares/${shareId}/driveItem?$select=id,name,size,file,parentReference,webUrl,lastModifiedDateTime`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  if (!res.ok) {
    logger.warn({ status: res.status, url }, 'Graph share resolution failed');
    return null;
  }
  return toRef((await res.json()) as RawDriveItem);
}

export interface ShareUrlResolution {
  /** 'file': the URL pointed straight at a file — use `item`.
   *  'folder-single-file': the URL pointed at a folder with exactly one file child — use `item` (the child).
   *  'folder-multiple-files': the URL pointed at a folder with more than one file — a person must pick from `candidates`.
   *  'not-found': the URL didn't resolve, or the folder had zero files. */
  kind: 'file' | 'folder-single-file' | 'folder-multiple-files' | 'not-found';
  item?: DriveItemRef;
  candidates?: DriveItemRef[];
}

/**
 * Folder-aware version of resolveShareUrl. Some Copilot Studio "upload and
 * sync" knowledge sources resolve (via the UI's own "Knowledge URL" field —
 * there is no public API for this, see graphFiles.ts header) to a FOLDER, not
 * a file — confirmed live: a source named after a folder with no real
 * filename resolved to a folder containing exactly one file, which is
 * genuinely the source's target (not a filename guess — Copilot Studio's own
 * UI pointed at this exact folder). When the folder has exactly one file,
 * that's as confident a match as a direct file URL. More than one file means
 * real ambiguity a person has to resolve, same as the search-candidate path.
 */
export async function resolveShareUrlSmart(graphToken: string, url: string): Promise<ShareUrlResolution> {
  const shareId = encodeShareId(url);
  const res = await fetch(
    `${GRAPH}/shares/${shareId}/driveItem?$select=id,name,size,file,folder,parentReference,webUrl,lastModifiedDateTime`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  if (!res.ok) {
    logger.warn({ status: res.status, url }, 'Graph share resolution failed');
    return { kind: 'not-found' };
  }
  const raw = (await res.json()) as RawDriveItem;

  if (raw.file) {
    const item = toRef(raw);
    return item ? { kind: 'file', item } : { kind: 'not-found' };
  }

  if (raw.folder && raw.id && raw.parentReference?.driveId) {
    const childRes = await fetch(`${GRAPH}/drives/${raw.parentReference.driveId}/items/${raw.id}/children`, {
      headers: { Authorization: `Bearer ${graphToken}` },
    });
    if (!childRes.ok) {
      logger.warn({ status: childRes.status, url }, 'Graph folder children lookup failed');
      return { kind: 'not-found' };
    }
    const childJson = (await childRes.json()) as { value?: RawDriveItem[] };
    const files = (childJson.value ?? [])
      .map((c) => toRef(c, raw.name))
      .filter((x): x is DriveItemRef => x !== null);
    if (files.length === 1) return { kind: 'folder-single-file', item: files[0] };
    if (files.length > 1) return { kind: 'folder-multiple-files', candidates: files };
    return { kind: 'not-found' };
  }

  return { kind: 'not-found' };
}

/** Download the raw bytes of a resolved drive item. Returns null on failure. */
export async function downloadDriveItemBytes(
  graphToken: string,
  item: DriveItemRef,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await fetch(`${GRAPH}/drives/${item.driveId}/items/${item.itemId}/content`, {
    headers: { Authorization: `Bearer ${graphToken}` },
  });
  if (!res.ok) {
    logger.warn({ status: res.status, itemId: item.itemId }, 'Graph file download failed');
    return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}
