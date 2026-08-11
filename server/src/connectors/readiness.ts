/**
 * "Will this connector migrate without errors?" — answered per connector, before the run.
 *
 * Joins the two halves: what the agent actually calls (detected from Dataverse) and what we
 * can actually reproduce (the captured swagger index + the vendor binding table). Kept
 * separate from `operationBinding.ts` so that module stays pure and unit-testable without
 * touching the filesystem.
 */
import { loadOpIndex } from './opIndex.js';
import { connectorReadiness, type ConnectorReadiness } from './operationBinding.js';

/**
 * Readiness for one connector, or undefined when no index has been captured for it.
 *
 * Undefined is deliberately distinct from "not ready": not-ready means we looked and found
 * a problem we can describe, undefined means we have nothing to say yet. Reporting the
 * second as the first would tell a customer their connector is broken when the truth is
 * that we have not captured it.
 */
export function readinessFor(connectorId: string, operations: string[] | undefined): ConnectorReadiness | undefined {
  const index = loadOpIndex(connectorId);
  if (!index) return undefined;
  return connectorReadiness(index, operations ?? []);
}

/** One line a non-engineer can act on, for the connector list in the UI and the report. */
export function readinessSummary(r: ConnectorReadiness | undefined, connectorId: string): string {
  if (!r) {
    return `${connectorId}: not yet supported — we have not captured this connector's API, so its tools will not be recreated.`;
  }
  if (r.ready) {
    return `${r.displayName}: ${r.bindable.length} operation(s) will be recreated against the vendor's API.`;
  }
  if (!r.bindable.length && !r.blocked.length) {
    return `${r.displayName}: we could not read which operations this agent uses, so we cannot promise its tools will work.`;
  }
  const first = r.blocked[0];
  return (
    `${r.displayName}: ${r.bindable.length} of ${r.bindable.length + r.blocked.length} operation(s) ` +
    `will be recreated. ${first.operationId} will not — ${first.reason}`
  );
}
