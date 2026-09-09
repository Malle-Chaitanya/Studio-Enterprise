/**
 * Reverse the operator's source→destination user map into the destination→source lookup a
 * per-caller tool needs at runtime.
 *
 * The operator fills the map in one direction, and it is legitimately many-to-one: one
 * person owns accounts in several source domains, so `alex@filefuze.co` and
 * `alex@qatestagent.com` both point at `alex@migrationn.com`. Reversing that is not a
 * bijection, and picking whichever entry iterated last resolves the caller to an arbitrary
 * source address — the wrong mailbox, read with total confidence.
 *
 * This used to drop every such destination, which is safe but refuses real people for a
 * collision the operator can see is not one. So rank the candidates instead, by the domain
 * they belong to, using a rule the operator stated rather than a guess:
 *
 *   1. The PRIMARY domain — the source domain of the operator's own account, discovered by
 *      looking up which source address maps to the destination admin running the migration.
 *      That is the tenant the migration is actually about; its accounts are the real ones.
 *   2. Every other domain, ranked by how many mappings it carries (a domain the operator
 *      mapped forty times is their main tenant; one mapped twice is a test tenant), ties
 *      broken alphabetically so the same map always resolves the same way.
 *
 * A tie WITHIN one domain is still dropped. Two accounts in the same tenant claiming one
 * destination is a genuine ambiguity no ordering rule can settle, and guessing there would
 * be exactly the failure this whole path exists to prevent.
 */

export interface CallerIdentityResolution {
  /** destination (lowercased) → source address, ready to serialize into the container. */
  map: Record<string, string>;
  /** Destinations settled by domain rank — reported so the choice is never silent. */
  resolved: { dest: string; chosen: string; setAside: string[] }[];
  /** Destinations still ambiguous after ranking; refused at runtime. */
  dropped: { dest: string; sources: string[] }[];
}

const domainOf = (email: string): string => email.toLowerCase().split('@')[1] ?? '';

/**
 * @param users        the operator's map, source address → destination address.
 * @param operatorDest the destination identity running the migration (the connected Google
 *                     admin). Its source domain becomes the primary. Empty is fine — the
 *                     count/alphabetical ranking still applies.
 */
export function resolveCallerIdentityMap(
  users: Record<string, string>,
  operatorDest: string,
): CallerIdentityResolution {
  const byDest = new Map<string, string[]>();
  for (const [ms, google] of Object.entries(users)) {
    if (!google || !ms) continue;
    const dest = String(google).toLowerCase();
    const list = byDest.get(dest) ?? [];
    // Same account restated (often just different casing) is not a collision.
    if (!list.some((s) => s.toLowerCase() === ms.toLowerCase())) list.push(ms);
    byDest.set(dest, list);
  }

  // Chicken-and-egg: the primary domain comes from the operator's own source account, but
  // that account may itself be one of several claiming the operator's destination. So rank
  // once WITHOUT a primary to settle it, then re-rank with the answer.
  const operatorSources = byDest.get(operatorDest.toLowerCase()) ?? [];
  const primaryDomain = operatorSources.length
    ? domainOf(pickByDomainOrder(operatorSources, rankDomains(byDest, '')))
    : '';

  const order = rankDomains(byDest, primaryDomain);

  const map: Record<string, string> = {};
  const resolved: CallerIdentityResolution['resolved'] = [];
  const dropped: CallerIdentityResolution['dropped'] = [];

  for (const [dest, sources] of byDest) {
    if (sources.length === 1) {
      map[dest] = sources[0];
      continue;
    }
    const chosen = pickByDomainOrder(sources, order);
    const rivals = sources.filter((s) => s !== chosen && domainOf(s) === domainOf(chosen));
    if (rivals.length) {
      dropped.push({ dest, sources: [...sources].sort() });
      continue;
    }
    map[dest] = chosen;
    resolved.push({ dest, chosen, setAside: sources.filter((s) => s !== chosen).sort() });
  }

  return { map, resolved, dropped };
}

/** Domains ordered best-first: primary, then by mapping count desc, then alphabetically. */
function rankDomains(byDest: Map<string, string[]>, primaryDomain: string): string[] {
  const counts = new Map<string, number>();
  for (const sources of byDest.values()) {
    for (const s of sources) {
      const d = domainOf(s);
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return [...counts.keys()].sort((a, b) => {
    if (a === primaryDomain) return -1;
    if (b === primaryDomain) return 1;
    const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

function pickByDomainOrder(sources: string[], order: string[]): string {
  const best = [...sources].sort((a, b) => {
    const ia = order.indexOf(domainOf(a));
    const ib = order.indexOf(domainOf(b));
    const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
    const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  return best[0];
}
