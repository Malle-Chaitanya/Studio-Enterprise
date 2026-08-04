import { logger } from '../logger.js';
import type { DriveItemRef } from './graphFiles.js';

/**
 * Search-and-confirm for SharePoint/OneDrive knowledge sources whose real
 * target Copilot Studio hides behind an opaque `skillConfiguration`
 * reference (see graphFiles.ts header for the full context). Rather than
 * requiring a human to copy a full "Knowledge URL", this searches for the
 * known filename in a deliberately NARROW scope — never a tenant-wide sweep:
 *
 *   - OneDrive: scoped to the ONE person who added the source (Copilot
 *     Studio shows "Modified by" for every knowledge source) — not every
 *     employee's OneDrive. Keeps both the privacy footprint and the risk of
 *     a same-name collision small.
 *   - SharePoint: scoped to specific sites when known (e.g. a sibling live-
 *     connector source on the same agent already named a site); otherwise a
 *     capped, explicit site list — never an unbounded tenant-wide crawl.
 *
 * Every result is a CANDIDATE, never an auto-applied answer — matching by
 * filename alone cannot be certain, only "likely." The caller is expected to
 * have a human confirm before treating a candidate as the source of truth
 * (see knowledgeDataStoreExecutor.ts's consumer of this).
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Cap per search so a single lookup can't run away in a huge tenant. */
const MAX_RESULTS = 10;

interface GraphSearchHit {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: unknown;
  parentReference?: { driveId?: string; name?: string };
}

function toDriveItemRef(hit: GraphSearchHit, fallbackContext: string): DriveItemRef | null {
  if (!hit.id || !hit.parentReference?.driveId || !hit.file) return null; // skip folders
  return {
    driveId: hit.parentReference.driveId,
    itemId: hit.id,
    name: hit.name ?? 'file',
    sizeBytes: hit.size,
    webUrl: hit.webUrl,
    lastModifiedDateTime: hit.lastModifiedDateTime,
    parentContext: hit.parentReference.name ?? fallbackContext,
  };
}

/**
 * Search ONE specific person's OneDrive for a file matching `filename`.
 * `userEmail` MUST come from the knowledge source's own "modified by" record
 * (resolved via Dataverse's systemuser lookup) — never a client-supplied or
 * guessed value, so the search stays scoped to the person who actually added
 * the source.
 */
export async function searchOneDriveForFile(
  graphToken: string,
  userEmail: string,
  filename: string,
): Promise<DriveItemRef[]> {
  const res = await fetch(
    `${GRAPH}/users/${encodeURIComponent(userEmail)}/drive/root/search(q='${encodeURIComponent(filename)}')` +
      `?$select=id,name,size,file,webUrl,lastModifiedDateTime,parentReference&$top=${MAX_RESULTS}`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  if (!res.ok) {
    logger.warn({ status: res.status, userEmail, filename }, 'OneDrive search failed');
    return [];
  }
  const json = (await res.json()) as { value?: GraphSearchHit[] };
  return (json.value ?? [])
    .map((h) => toDriveItemRef(h, 'OneDrive'))
    .filter((x): x is DriveItemRef => x !== null);
}

/**
 * Search a single known SharePoint site's default document library for a
 * file matching `filename`. Call once per site in a caller-supplied,
 * explicitly bounded list — never enumerate every site in the tenant here.
 */
export async function searchSharePointSiteForFile(
  graphToken: string,
  siteId: string,
  filename: string,
): Promise<DriveItemRef[]> {
  const driveRes = await fetch(`${GRAPH}/sites/${siteId}/drive?$select=id,name`, {
    headers: { Authorization: `Bearer ${graphToken}` },
  });
  if (!driveRes.ok) {
    logger.warn({ status: driveRes.status, siteId }, 'SharePoint site drive lookup failed');
    return [];
  }
  const drive = (await driveRes.json()) as { id?: string; name?: string };
  if (!drive.id) return [];

  const res = await fetch(
    `${GRAPH}/drives/${drive.id}/root/search(q='${encodeURIComponent(filename)}')` +
      `?$select=id,name,size,file,webUrl,lastModifiedDateTime,parentReference&$top=${MAX_RESULTS}`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  if (!res.ok) {
    logger.warn({ status: res.status, siteId, filename }, 'SharePoint site search failed');
    return [];
  }
  const json = (await res.json()) as { value?: GraphSearchHit[] };
  return (json.value ?? [])
    .map((h) => toDriveItemRef(h, drive.name ?? siteId))
    .filter((x): x is DriveItemRef => x !== null);
}

/**
 * Combined search across a OneDrive owner (when known) and a bounded list of
 * SharePoint sites (when known). Returns ALL candidates found, deduplicated
 * by (driveId, itemId) — the caller decides what "confirmed" means (single
 * strong match vs. human picks from a list). Never throws on a per-source
 * search failure — a site that errors just contributes zero candidates.
 */
export async function findCandidates(
  graphToken: string,
  filename: string,
  opts: { oneDriveOwnerEmail?: string; sharePointSiteIds?: string[] },
): Promise<DriveItemRef[]> {
  const results: DriveItemRef[] = [];
  if (opts.oneDriveOwnerEmail) {
    results.push(...(await searchOneDriveForFile(graphToken, opts.oneDriveOwnerEmail, filename)));
  }
  for (const siteId of opts.sharePointSiteIds ?? []) {
    results.push(...(await searchSharePointSiteForFile(graphToken, siteId, filename)));
  }
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.driveId}:${r.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
