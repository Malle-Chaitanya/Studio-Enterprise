/**
 * Catalog version PINNING — step 4 of the dynamic-connector hardening work.
 *
 * WHY THIS EXISTS. The catalog has no version HISTORY: updating an operation overwrites it
 * in place (db/repos/connectorCatalog.ts's `putCatalogOperation` is a plain upsert). So a
 * retry of an INSERT run, reading the catalog fresh each time, would silently use whatever
 * the catalog says NOW — even if that is a different definition than the one the ORIGINAL
 * attempt used. That breaks this project's core idempotency guarantee: a retry must
 * reproduce the original run, not drift from it because unrelated data changed underneath.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It cannot replay against the exact OLD definition —
 * there is no stored history to replay from. It can only detect that the definition moved
 * and refuse to proceed silently, which is the honest, achievable half of "pin a version":
 * remember what was used, and stop (rather than guess) the moment that no longer matches.
 * A full version-history collection would be new infrastructure this one-connector pilot
 * does not yet need — see .claude/memory/decisions.md.
 *
 * Pure, no I/O: the caller reads/writes the pins map (a plain `Record<string, number>`,
 * additively stored on `StagedAgent.connectorCatalogPins`) and this module only decides
 * what the CURRENT attempt should do given what was recorded before.
 */

export type CatalogPinCheck =
  | { status: 'first-time' }
  | { status: 'match' }
  | { status: 'conflict'; pinnedVersion: number; currentVersion: number };

/** One key per (connector, the SOURCE operation id Copilot Studio recorded) — matches how
 *  a staged agent's tools are keyed, not our own internal `operationKey`. */
export function catalogPinKey(connectorId: string, sourceOperationId: string): string {
  return `${connectorId}:${sourceOperationId}`;
}

/**
 * Has this exact (connector, operation) been pinned before for this agent, and if so, does
 * it still match the catalog version we are about to use?
 */
export function checkCatalogPin(
  pins: Record<string, number> | undefined,
  connectorId: string,
  sourceOperationId: string,
  currentVersion: number,
): CatalogPinCheck {
  const pinned = pins?.[catalogPinKey(connectorId, sourceOperationId)];
  if (pinned === undefined) return { status: 'first-time' };
  if (pinned === currentVersion) return { status: 'match' };
  return { status: 'conflict', pinnedVersion: pinned, currentVersion };
}

/** Pure merge helper: the pins map an agent should be saved with after this attempt,
 *  given which (connector, operation, version) triples were freshly used this run. */
export function withCatalogPins(
  existing: Record<string, number> | undefined,
  used: Array<{ connectorId: string; sourceOperationId: string; catalogVersion: number }>,
): Record<string, number> {
  const next = { ...(existing ?? {}) };
  for (const u of used) next[catalogPinKey(u.connectorId, u.sourceOperationId)] = u.catalogVersion;
  return next;
}
