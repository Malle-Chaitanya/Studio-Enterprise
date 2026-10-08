import type { ConnectorOpIndex } from '../connectors/operationBinding.js';

/**
 * Which vendor OAuth scopes a migration will need, DERIVED from the connectors it is
 * actually migrating.
 *
 * WHY THIS EXISTS. Every connector's definition already states the scopes Microsoft's own
 * connector requests — `connectionParameters.Token.oAuthSettings.scopes`, captured into
 * `ConnectorOpIndex.connectionAuth` — and nothing read it. So the scope list lived in a
 * human's head and in a hand-maintained constant, and the two drifted:
 *
 *   `shared_googletasks` bound 5 operations and we never requested the tasks scope. The
 *   tools would have deployed and failed to authenticate — green run, dead agent. Found by
 *   probing, which means it was found by luck rather than by the product.
 *
 * Deriving it removes the whole class. A customer using a connector nobody anticipated
 * still gets the right scope list, because the list comes from THEIR connectors rather than
 * from ours.
 *
 * WHAT THIS IS NOT. It states what the vendor's API will require. It cannot grant anything:
 * a Workspace admin authorizes the service account's client id, and an Entra admin consents
 * for Microsoft. The point is that the product can now say exactly WHICH scopes, per
 * customer, before a migration runs instead of after a tool 401s.
 */

export interface ScopeRequirement {
  /** The vendor as the connector names it: `Google`, `Aad`, `Dropbox`. */
  identityProvider: string;
  /** Every distinct scope this provider's connectors ask for, sorted for stable output. */
  scopes: string[];
  /** Which connector asked for which — so a surprising scope can be traced, not argued about. */
  byConnector: Record<string, string[]>;
}

/**
 * A DWD grant matches scope strings LITERALLY: a grant holding `.../auth/calendar` does not
 * satisfy a request for `.../auth/calendar.readonly`, and the refusal reads as "calendar is
 * not authorized". Comparing with any normalisation at all reproduces that confusion, so
 * nothing here trims, widens or folds `.readonly` variants together.
 */
function dedupe(values: string[]): string[] {
  // Power Platform stores a connection's scopes as OAuth sends them - one string, space
  // separated - so a two-scope connector arrives as a single entry. Treating that entry as
  // one scope produces a grant line no admin console accepts, and a "missing scope" that
  // does not exist. Found live on shared_googlesheet.
  return [...new Set(values.flatMap((v) => v.split(/\s+/)).filter(Boolean))].sort();
}

export function requiredVendorScopes(indexes: ConnectorOpIndex[]): ScopeRequirement[] {
  const byProvider = new Map<string, { scopes: string[]; byConnector: Record<string, string[]> }>();

  for (const index of indexes) {
    for (const auth of Object.values(index.connectionAuth ?? {})) {
      const provider = auth.identityProvider;
      // No provider or no scopes means this connection is not OAuth — an API key, a
      // connection string, a gateway. Those need a credential but not a scope grant, and
      // inventing a provider name for them would put noise in an operator's checklist.
      if (!provider || !auth.scopes?.length) continue;
      const bucket = byProvider.get(provider) ?? { scopes: [], byConnector: {} };
      bucket.scopes.push(...auth.scopes);
      bucket.byConnector[index.connectorId] = dedupe([
        ...(bucket.byConnector[index.connectorId] ?? []),
        ...auth.scopes,
      ]);
      byProvider.set(provider, bucket);
    }
  }

  return [...byProvider.entries()]
    .map(([identityProvider, b]) => ({
      identityProvider,
      scopes: dedupe(b.scopes),
      byConnector: b.byConnector,
    }))
    .sort((a, b) => a.identityProvider.localeCompare(b.identityProvider));
}

export interface ScopeGap {
  identityProvider: string;
  missing: string[];
  /** Which connectors stop working if the gap is not closed, for the operator's message. */
  affectedConnectors: string[];
}

/**
 * What is required but not yet granted.
 *
 * `granted` is what an admin has actually authorized — discovered by attempting a token, not
 * assumed from config, because the config says what we ASK for and the grant says what we
 * GET. Those differing silently is the failure this whole module exists to prevent.
 */
export function scopeGaps(
  required: ScopeRequirement[],
  granted: Record<string, string[]>,
): ScopeGap[] {
  const gaps: ScopeGap[] = [];
  for (const req of required) {
    const have = new Set(granted[req.identityProvider] ?? []);
    const missing = req.scopes.filter((s) => !have.has(s));
    if (!missing.length) continue;
    gaps.push({
      identityProvider: req.identityProvider,
      missing,
      affectedConnectors: Object.entries(req.byConnector)
        .filter(([, scopes]) => scopes.some((s) => missing.includes(s)))
        .map(([connectorId]) => connectorId)
        .sort(),
    });
  }
  return gaps;
}
