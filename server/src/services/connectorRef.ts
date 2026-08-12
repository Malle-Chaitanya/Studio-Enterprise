/**
 * Pure parsers for the connector fields inside a Copilot Studio TaskDialog payload.
 *
 * These live apart from `dataverse.ts` for one reason: they are pure, and that module is
 * not. Importing `dataverse.ts` pulls in the Zod-validated fail-fast `config`, so the two
 * most load-bearing parsers in the extractor could not be unit-tested without a live
 * environment. Both have already been the site of a silent data-loss bug — see the notes on
 * each — which is exactly the class of function `.claude/rules/testing-standard.md` says to
 * cover first.
 *
 * No imports, no I/O. Keep it that way.
 */

/**
 * `<prefix>.shared_jira.<guid>` → `shared_jira`.
 *
 * The middle dot-segment is the connector id. First-party connectors are `shared_*`;
 * CUSTOM connectors published by the customer are not, and matching `shared_` alone
 * returned `undefined` for every one of them. That is not a graceful degradation: a tool
 * with no `connectorId` never reaches `agentConnectorIds()`, so it never reaches the
 * unsupported list either, so the agent migrated green with a capability silently missing
 * and nothing in the report to say so. Falling back to the middle segment means a custom
 * connector is at least NAMED — we still cannot call it, but the customer is told.
 */
export function connectorIdFromConnectionReference(ref: string): string | undefined {
  const firstParty = /\b(shared_[a-z0-9_]+)/i.exec(ref)?.[1];
  if (firstParty) return firstParty.toLowerCase();
  // `<solutionprefix>_<logicalname>.<connectorid>.<connectionrefid>` — take the middle.
  const parts = ref.split('.').filter(Boolean);
  if (parts.length >= 3) {
    const middle = parts[1].trim();
    if (middle) return middle.toLowerCase();
  }
  return undefined;
}

/**
 * Operation families that identify their connector on their own.
 *
 * Dataverse's connector exposes a distinctive set of `…WithOrganization` operations
 * (`ListRecordsWithOrganization`, `PerformUnboundActionWithOrganization`,
 * `GetItemWithOrganization`, `UpdateRecordWithOrganization`,
 * `PerformBoundActionWithOrganization`). No other connector in the captured index uses
 * that suffix, and they always carry `organization: current` in the binding.
 */
const OPERATION_CONNECTOR_HINTS: Array<{ re: RegExp; connectorId: string }> = [
  { re: /WithOrganization$/i, connectorId: 'shared_commondataserviceforapps' },
];

/** The connector an operation id can only belong to, or undefined. */
export function connectorIdFromOperation(operationId: string | undefined): string | undefined {
  if (!operationId) return undefined;
  return OPERATION_CONNECTOR_HINTS.find((h) => h.re.test(operationId))?.connectorId;
}

/**
 * Resolve the connector for a connector action, preferring the strongest evidence.
 *
 * TOPIC-EMBEDDED actions (`kind: InvokeConnectorAction` inside an AdaptiveDialog) carry a
 * connection reference in a shape the TaskDialog parser was never written for. Live
 * example:
 *
 *     raw ref: QMA.Incident.DVPluginConnection
 *     op:      PerformUnboundActionWithOrganization
 *
 * The middle segment there is the ENTITY (`Incident`), not a connector — so the fallback
 * produced `incident`, which matches no registry entry, so the operation bound to nothing
 * and was dropped **with no bound call and no fidelity note**. Silently absent, which is
 * worse than refused: the report said nothing at all. Measured 2026-08-12: 29 operations
 * across 5 agents, five of which had 0 working operations as a result.
 *
 * Order of evidence:
 *   1. `shared_*` in the reference — the connector states itself. `exact`.
 *   2. The operation family — `…WithOrganization` is Dataverse and nothing else. `inferred`.
 *   3. The middle segment — a custom connector we cannot call but can NAME, so it still
 *      reaches the unsupported list and the report. `named-only`.
 *
 * The confidence is returned rather than discarded so the caller can say which it was;
 * a guess presented as a fact is how the entity name got treated as a connector id.
 */
export function resolveConnectorId(
  ref: string | undefined,
  operationId?: string,
): { connectorId?: string; confidence: 'exact' | 'inferred' | 'named-only' | 'unknown' } {
  if (ref) {
    const firstParty = /\b(shared_[a-z0-9_]+)/i.exec(ref)?.[1];
    if (firstParty) return { connectorId: firstParty.toLowerCase(), confidence: 'exact' };
  }
  const fromOp = connectorIdFromOperation(operationId);
  if (fromOp) return { connectorId: fromOp, confidence: 'inferred' };
  const middle = ref ? connectorIdFromConnectionReference(ref) : undefined;
  if (middle) return { connectorId: middle, confidence: 'named-only' };
  return { confidence: 'unknown' };
}

/**
 * Whose credentials does this action run under?
 *
 *   connectionProperties:
 *     mode: Invoker      → the SIGNED-IN END USER's own connection
 *   mode: maker / absent → one shared connection the maker configured
 *
 * This is the single most consequential field we extract, and it was previously thrown
 * away: an Invoker action gives each person only what they can already see, while our
 * migration wires one app-only service credential for everyone. Migrating an Invoker
 * agent without saying so hands every end user the service account's whole view — a
 * privilege escalation, not a fidelity gap.
 *
 * Verified live 2026-08-10 (spikes/_diag_connection_auth_mode.ts): it appears in the
 * componenttype-9 payload under connectionProperties, and nowhere on the
 * `connectionreferences` row — that table's only auth-shaped columns are Dataverse's own
 * audit fields. The bot-level `authenticationmode` does not discriminate either.
 */
export function connectionAuthModeFrom(data: string): 'invoker' | 'maker' | undefined {
  const mode = /^\s*connectionProperties:\s*$[\s\S]{0,200}?^\s*mode:\s*(\w+)\s*$/m.exec(data)?.[1];
  if (!mode) return undefined;
  return /^invoker$/i.test(mode) ? 'invoker' : 'maker';
}
