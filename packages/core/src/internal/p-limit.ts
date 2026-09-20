/**
 * Run async tasks with a concurrency cap, preserving result order. Zero-dep
 * (no `p-map`/`p-limit` packages) to honor the zero-runtime-dependency rule.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: { drainOnError?: boolean; onError?: (error: unknown) => void },
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const cap = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  let failure: { error: unknown } | undefined;

  async function worker(): Promise<void> {
    for (;;) {
      if (options?.drainOnError && failure) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        if (!options?.drainOnError) throw error;
        if (!failure) failure = { error };
        options.onError?.(error);
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  if (failure) throw failure.error;
  return results;
}
