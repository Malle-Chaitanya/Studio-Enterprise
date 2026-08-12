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
 * A `shared_*` connector id, HYPHENS INCLUDED.
 *
 * Custom connectors are named after their display name with the spaces percent-encoded, so
 * "Get CRM objects from Hubspot" becomes
 * `shared_get-20crm-20objects-20from-20hubspot-5fdd816392-2363868395b0ae9b`. The original
 * character class `[a-z0-9_]+` stopped at the first hyphen and yielded `shared_get` — an id
 * that belongs to no connector at all. It matched nothing in the registry, so the tool was
 * reported unsupported under a NAME THAT DOES NOT EXIST, which is worse than reporting it
 * unsupported: the customer cannot even look it up.
 *
 * Ends at `.` (segment boundary) or whitespace, so first-party ids are unaffected —
 * `…​.shared_confluence.cbc262…` still yields `shared_confluence`.
 */
const SHARED_ID = /\b(shared_[a-z0-9_-]+)/i;

/**
 * `/providers/Microsoft.PowerApps/apis/shared_foo` → `shared_foo`.
 *
 * The `kind: ConnectorTool` row states its connector as an ARM resource path. That is the
 * connector saying who it is — no inference, no parsing of a reference name that may or may
 * not embed the id. Strongest evidence available; prefer it over everything else.
 */
export function connectorIdFromArmPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const id = /\/apis\/([^/\s]+)\s*$/.exec(path.trim())?.[1];
  return id ? id.toLowerCase() : undefined;
}

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
  const firstParty = SHARED_ID.exec(ref)?.[1];
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
  armPath?: string,
): { connectorId?: string; confidence: 'exact' | 'inferred' | 'named-only' | 'unknown' } {
  const fromArm = connectorIdFromArmPath(armPath);
  if (fromArm) return { connectorId: fromArm, confidence: 'exact' };
  if (ref) {
    const firstParty = SHARED_ID.exec(ref)?.[1];
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
  // `kind: ConnectorTool` rows state it as a top-level `authMode:` instead of nesting it
  // under connectionProperties. Missing this does not lose the tool, it loses the fact
  // that the tool runs as the END USER — and migrating an Invoker tool under our single
  // service credential silently hands every user the service account's whole view. A
  // privilege escalation reported as a clean migration.
  const flat = /^\s*authMode:\s*(\w+)\s*$/m.exec(data)?.[1];
  if (flat) return /^invoker$/i.test(flat) ? 'invoker' : 'maker';
  const mode = /^\s*connectionProperties:\s*$[\s\S]{0,200}?^\s*mode:\s*(\w+)\s*$/m.exec(data)?.[1];
  if (!mode) return undefined;
  return /^invoker$/i.test(mode) ? 'invoker' : 'maker';
}
