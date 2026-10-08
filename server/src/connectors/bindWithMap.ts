import { bindOperation, VENDOR_BINDINGS } from './operationBinding.js';
import type { BindingResult, ConnectorOpIndex, VendorApiSurface } from './operationBinding.js';
import { buildMappedOperation, lookupMapEntry, verifyMapEntry } from './operationMap.js';
import { OPERATION_MAP } from './maps/index.js';

/**
 * The whole binding decision, in the order it must happen, in ONE place.
 *
 *   tier 0  a STATED equivalence from the operation map. Tried first because it is the only
 *           tier that can reach a connector whose paths are a Power Platform abstraction
 *           with no vendor path inside them, which is 81 of Google's 131 operations.
 *   tier 1  path-shape binding, confirmed against the vendor's published API when one could
 *           be fetched (`bindOperation`).
 *
 * Shared rather than reimplemented per caller. The probes exist to report what the MIGRATION
 * will do; a probe with its own copy of this order answers a different question than the
 * product does and is worse than no probe, because it is believed. This codebase has paid
 * for that twice already.
 *
 * The map entry is re-verified against the vendor's description on every call. It is pure
 * and offline, so the cost is nothing, and the alternative is a mapping that keeps being
 * used after the API it describes has changed.
 */
export function bindWithMap(
  index: ConnectorOpIndex,
  operationId: string,
  surface: VendorApiSurface | undefined,
  /** Lossy-mapping notes from the entry, for the caller to turn into FidelityNotes. */
  sink?: string[],
): BindingResult {
  const entry = lookupMapEntry(OPERATION_MAP, index.connectorId, operationId);
  if (entry && surface && verifyMapEntry(entry, surface, index).status === 'verified') {
    const mapped = buildMappedOperation(
      entry,
      surface,
      index,
      VENDOR_BINDINGS[index.connectorId]?.auth ?? 'google-oauth',
    );
    if (mapped.status === 'bindable') {
      if (sink) sink.push(...mapped.notes);
      return { status: 'bindable', operation: mapped.operation };
    }
    // A valid entry this build cannot deploy yet (multi-step, or a body shape of its own).
    // Reported as its own refusal so the gap reads as "known, pending runtime" rather than
    // falling through to a path-shape refusal that blames the connector.
    if (mapped.status === 'needs-runtime') {
      return {
        status: 'proxy-only',
        connectorId: index.connectorId,
        operationId,
        reason: `mapped, pending runtime support: ${mapped.reason}`,
      };
    }
  }
  return bindOperation(index, operationId, surface);
}
