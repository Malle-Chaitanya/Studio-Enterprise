import { logger } from '../logger.js';
import { assistantBase } from './gemini.js';
import { geminiWriteLimiter } from './rateLimiter.js';
import type { GeminiDestination } from '../types.js';

/**
 * Gemini Enterprise agent *file* operations. Uploaded knowledge files attach
 * directly to a low-code agent via `lowCodeAgentDefinition.agentFiles[]` — NOT
 * via a data store (confirmed by inspecting a real agent's JSON: a manually
 * added PDF appeared as `agentFiles: [{ name, fileName, mimeType }]`).
 *
 * Flow for migrating an uploaded file:
 *   1. fetch bytes from Dataverse (services/dataverse.fetchFileAttachmentBytes)
 *   2. uploadAgentFile()  → creates a `…/agents/{id}/files/{fileId}` resource
 *   3. ensure the returned reference is present in agentFiles[]
 *
 * ⚠️ The upload request shape (media upload) is the one piece not fully public;
 *    _diag_upload_file.ts verifies it in isolation before we wire it in.
 */

const HOST = 'https://discoveryengine.googleapis.com';

/** Map a filename extension to a proper MIME type (Dataverse serves everything
 * as application/octet-stream, which stops Gemini from previewing/indexing). */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Best MIME type for a file: extension-derived, falling back to a hint. */
export function mimeTypeForFile(fileName: string, hint?: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (hint && hint !== 'application/octet-stream') return hint;
  return 'application/octet-stream';
}

export interface AgentFile {
  name: string; // …/agents/{id}/files/{fileId}
  fileName: string;
  mimeType: string;
}

/** v1alpha resource path for one agent. */
export function agentResourcePath(dest: GeminiDestination, agentId: string): string {
  // assistantBase already ends at …/assistants/{assistant}; strip the host+version prefix.
  const base = assistantBase(dest).replace(`${HOST}/v1alpha/`, '');
  return `${base}/agents/${agentId}`;
}

/**
 * Attach uploaded files to the agent by writing the full agentFiles list onto
 * lowCodeAgentDefinition (uploading a file creates the resource but does NOT add
 * it to the agent — the UI issues a follow-up UpdateAgent, mirrored here).
 */
export async function updateAgentFiles(
  dest: GeminiDestination,
  saToken: string,
  agentId: string,
  agentFiles: AgentFile[],
): Promise<{ ok: boolean; error?: string }> {
  const url = `${HOST}/v1alpha/${agentResourcePath(dest, agentId)}?updateMask=lowCodeAgentDefinition.agentFiles`;
  await geminiWriteLimiter.acquire();
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lowCodeAgentDefinition: { agentFiles } }),
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 300)}` };
  return { ok: true };
}

/** Read the agent's current agentFiles list. */
export function readAgentFiles(agent: Record<string, unknown> | null): AgentFile[] {
  const def = agent?.lowCodeAgentDefinition as { agentFiles?: AgentFile[] } | undefined;
  return def?.agentFiles ?? [];
}

/** GET one agent's full definition. */
export async function getAgent(
  dest: GeminiDestination,
  saToken: string,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${HOST}/v1alpha/${agentResourcePath(dest, agentId)}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) {
    logger.warn(`getAgent ${agentId} failed (${res.status})`);
    return null;
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Upload a file to an agent via `files:upload` using Google's RESUMABLE upload
 * protocol (confirmed from the Gemini UI's network trace: a `files:upload`
 * start call followed by a `files:upload?upload_id=…` finalize call).
 *
 *   1. START    — POST …/files:upload with X-Goog-Upload-Command: start +
 *                 metadata { fileName, mimeType }; response carries the resumable
 *                 session URL in the `X-Goog-Upload-URL` header.
 *   2. FINALIZE — POST that URL with X-Goog-Upload-Command: "upload, finalize"
 *                 and the raw bytes.
 *
 * Returns the finalize response (the created AgentFile or an Operation) as `raw`.
 */
export async function uploadAgentFile(
  dest: GeminiDestination,
  saToken: string,
  agentId: string,
  file: { fileName: string; mimeType: string; bytes: Buffer },
): Promise<{ ok: boolean; raw?: unknown; error?: string }> {
  const parent = agentResourcePath(dest, agentId);
  const startUrl = `${HOST}/upload/v1alpha/${parent}/files:upload`;

  // Step 1 — initiate the resumable upload. Metadata (name, type, size) rides in
  // X-Goog-Upload-* headers; the start body is empty for this method.
  await geminiWriteLimiter.acquire();
  const start = await fetch(startUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${saToken}`,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-File-Name': encodeURIComponent(file.fileName),
      'X-Goog-Upload-Header-Content-Length': String(file.bytes.length),
      'X-Goog-Upload-Header-Content-Type': file.mimeType,
    },
  });
  if (!start.ok) return { ok: false, error: `start ${start.status}: ${(await start.text()).slice(0, 300)}` };

  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    return { ok: false, error: `start ok but no X-Goog-Upload-URL header (got: ${[...start.headers.keys()].join(', ')})` };
  }

  // Step 2 — send the bytes and finalize in one shot.
  await geminiWriteLimiter.acquire();
  const fin = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${saToken}`,
      'Content-Type': file.mimeType,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    body: file.bytes,
  });
  if (!fin.ok) return { ok: false, error: `finalize ${fin.status}: ${(await fin.text()).slice(0, 300)}` };

  const raw = await fin.json().catch(() => ({}));
  return { ok: true, raw };
}
