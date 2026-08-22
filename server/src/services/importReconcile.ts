/**
 * Import reconciliation for Discovery Engine `ImportDocuments`.
 *
 * The correctness rule: **a migration's "N/N indexed" must come from the import
 * operation's own result, never from the number of files we uploaded.**
 * ImportDocuments is a long-running operation; a file can upload to GCS fine and
 * still fail to index (corrupt/scanned PDF, password-protected, parse error).
 * Counting uploads reports "18/18 ✓" while documents are silently unsearchable.
 *
 * PURE: takes the operation payload, returns a truthful breakdown. Testable with
 * fixtures — no live Discovery Engine needed.
 */

/** Shape of a completed Discovery Engine importDocuments LRO (fields we read). */
export interface ImportOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  metadata?: {
    successCount?: number | string;
    failureCount?: number | string;
    totalCount?: number | string;
  };
  response?: {
    /** Per-document error samples. Field is `message` (confirmed live 2026-08-21
     *  against a real ImportDocumentsResponse) — NOT `errorMessage`, which this type
     *  incorrectly declared before, silently discarding every real error (e.g. a
     *  documents_regional quota-exceeded message) as the generic "unknown error"
     *  fallback below. There is no separate `document` field either — the failing
     *  document's id is embedded in `message` itself ("...ingest document with id: `...`").
     */
    errorSamples?: { code?: number; message?: string }[];
  };
}

export interface ImportReconciliation {
  /** The operation finished (done && no top-level error). */
  complete: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  /** succeeded === attempted && attempted > 0 && no operation-level error. */
  allIndexed: boolean;
  /** Up to a few human-readable failure reasons for the report. */
  failureSamples: string[];
  /** Operation-level (whole-import) error, if the LRO itself failed. */
  operationError?: string;
}

function num(v: number | string | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Reconcile a completed import operation against the number of files we intended
 * to import. `attemptedUploads` is the count WE sent — used only to detect the
 * silent gap where the operation indexed fewer than we uploaded.
 */
export function reconcileImport(
  op: ImportOperation | null | undefined,
  attemptedUploads: number,
): ImportReconciliation {
  if (!op) {
    return {
      complete: false,
      attempted: attemptedUploads,
      succeeded: 0,
      failed: attemptedUploads,
      allIndexed: false,
      failureSamples: [],
      operationError: 'no operation returned',
    };
  }

  const operationError = op.error?.message
    ? `${op.error.code ?? ''} ${op.error.message}`.trim()
    : undefined;

  const succeeded = num(op.metadata?.successCount);
  const reportedFailed = num(op.metadata?.failureCount);
  // Trust the operation's total when present; otherwise fall back to what we sent.
  const total = num(op.metadata?.totalCount) || attemptedUploads;

  // The silent gap: operation accounted for fewer docs than we uploaded.
  const unaccounted = Math.max(0, attemptedUploads - (succeeded + reportedFailed));
  const failed = reportedFailed + unaccounted;

  const failureSamples = (op.response?.errorSamples ?? [])
    .slice(0, 5)
    .map((s) => s.message ?? 'unknown error');
  if (unaccounted > 0) {
    failureSamples.push(`${unaccounted} document(s) uploaded but not accounted for by the import — treat as failed until verified.`);
  }

  const complete = Boolean(op.done) && !operationError;

  return {
    complete,
    attempted: total,
    succeeded,
    failed,
    allIndexed: complete && failed === 0 && succeeded === total && total > 0,
    failureSamples,
    operationError,
  };
}
