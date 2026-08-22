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
    /**
     * Per-document failures. Discovery Engine returns these as `google.rpc.Status`
     * (`code` / `message` / `details`), NOT as `{errorMessage}` — which is what this type
     * used to declare. TypeScript could not catch the mismatch because the payload is
     * untyped JSON at the boundary, so every sample rendered as "unknown error" and a
     * 0/178 import reported a count with no cause (live 2026-08-19).
     *
     * Both spellings are accepted, and `toSampleText` keeps a raw fallback so an
     * unrecognised shape still prints something a human can act on.
     */
    errorSamples?: Array<{
      message?: string;
      errorMessage?: string;
      code?: number;
      document?: string;
      details?: unknown[];
    }>;
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

  const failureSamples = (op.response?.errorSamples ?? []).slice(0, 5).map(toSampleText);
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


/**
 * Render one import error sample as something a human can act on.
 *
 * Falls back to the RAW sample rather than to the words "unknown error". A literal
 * "unknown error" is indistinguishable from a bug in this function, and that ambiguity
 * cost two full migration runs: the API had reported the cause every time, and we printed
 * a placeholder over it.
 */
export function toSampleText(s: {
  message?: string;
  errorMessage?: string;
  code?: number;
  document?: string;
  details?: unknown[];
}): string {
  const doc = s.document ? `${s.document.split('/').pop()}: ` : '';
  const text =
    s.message?.trim() ||
    s.errorMessage?.trim() ||
    (s.details?.length ? JSON.stringify(s.details).slice(0, 300) : '');
  if (text) return `${doc}${s.code ? `[${s.code}] ` : ''}${text}`;

  // Nothing recognised. Print the sample itself so the next run tells us the real shape
  // instead of hiding it behind a placeholder again.
  const raw = JSON.stringify(s);
  return `${doc}unparsed import error sample: ${raw.slice(0, 300)}`;
}
