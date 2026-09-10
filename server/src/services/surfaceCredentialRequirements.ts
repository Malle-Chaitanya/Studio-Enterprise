/**
 * Which connector credentials a screen must ask for, once surface substitutions are taken
 * into account.
 *
 * The Connectors step is driven by the connectors the SOURCE agents reference. That is the
 * wrong list the moment a surface decision points somewhere else: an agent whose source is
 * `shared_office365` and whose decision is "Use Gmail" authenticates as `shared_gmail`, a
 * different credential group with a different key. Asking only about the source meant the
 * Google credential was never offered, there was no way to supply it, and the migration
 * deployed mail tools that could not authenticate — green run, dead agent (live 2026-09-10).
 */

/** The subset of a recorded surface decision this needs. */
export interface SurfaceDecisionRef {
  sourceConnectorId: string;
  targetConnectorId?: string;
}

/**
 * @param ids         connector ids the caller already knows it needs (source connectors).
 * @param decisions   surface decisions recorded for this customer.
 * @param isRegistered whether a connector id is a real registry connector — `cloudsql` is a
 *                     decision, not a connector, and has no credential card to render.
 * @returns `ids` plus every DECIDED target, order preserved, no duplicates. Only decided
 *          targets: listing every possible one would demand credentials for platforms the
 *          customer has not chosen and may never use.
 */
export function expandWithDecidedSurfaceTargets(
  ids: string[],
  decisions: SurfaceDecisionRef[],
  isRegistered: (id: string) => boolean,
): string[] {
  const out = [...ids];
  const seen = new Set(out);
  for (const { sourceConnectorId, targetConnectorId } of decisions) {
    if (!seen.has(sourceConnectorId)) continue;
    if (!targetConnectorId || targetConnectorId === sourceConnectorId) continue;
    if (!isRegistered(targetConnectorId) || seen.has(targetConnectorId)) continue;
    out.push(targetConnectorId);
    seen.add(targetConnectorId);
  }
  return out;
}
