/**
 * Bounded-concurrency fan-out helper. Shared by any layer that needs to run many
 * external calls in parallel without an unbounded `Promise.all` at an API (the
 * project's code-style rule). The orchestrator keeps its own `mapPool` for the
 * migration pools; this is the general-purpose, result-collecting variant.
 */

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapPoolCollect<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
