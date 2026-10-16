/**
 * Estimates how far a server's clock runs ahead of `Date.now()`.
 *
 * One sample's midpoint is only as good as its round trip: the first query on
 * a pool also pays for the connection, and a busy machine (parallel lanes, a
 * full suite) stretches any single trip. The sample with the shortest round
 * trip has the least biased midpoint, so it wins; `error` bounds the estimate
 * by half that trip (plus a millisecond for the server's own rounding), and a
 * harness adds it to its time slack.
 */
export interface ClockSkew {
  /** Server time minus local time, in ms. */
  skew: number;
  /** How far `skew` can be off, in ms (half the best round trip, rounded up, plus 1). */
  error: number;
}

export async function estimateClockSkew(
  readServerMs: () => Promise<number>,
  samples = 7,
): Promise<ClockSkew> {
  let bestTrip = Number.POSITIVE_INFINITY;
  let skew = 0;
  for (let index = 0; index < samples; index++) {
    const sent = Date.now();
    const at = await readServerMs();
    const received = Date.now();
    const trip = received - sent;
    if (trip < bestTrip) {
      bestTrip = trip;
      skew = at - (sent + received) / 2;
    }
  }
  return { skew, error: Math.ceil(bestTrip / 2) + 1 };
}
