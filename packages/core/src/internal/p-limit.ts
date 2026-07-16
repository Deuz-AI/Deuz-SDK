/**
 * Run async tasks with a concurrency cap, preserving result order. Zero-dep
 * (no `p-map`/`p-limit` packages) to honor the zero-runtime-dependency rule.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const cap = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}
