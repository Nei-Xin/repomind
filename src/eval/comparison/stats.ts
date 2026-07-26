/** Deterministic PRNG so a report is byte-reproducible across runs. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_SEED = 20260726;
export const BOOTSTRAP_RESAMPLES = 10_000;

export interface DeltaEstimate {
  mean: number;
  ci95: [number, number];
  verdict: "A better" | "B better" | "indistinguishable";
  n: number;
}

/**
 * Paired bootstrap over fixtures, which is the resampling unit: content
 * metrics are exactly deterministic, so run-to-run variance is zero and the
 * only variance worth reporting is which fixtures were chosen.
 *
 * `higherIsBetter` decides the direction of the verdict. A verdict is only
 * issued when the interval excludes zero — the renderer must never print
 * "better" for an interval that straddles it.
 */
export function pairedBootstrapCi(
  pairs: Array<{ a: number; b: number }>,
  higherIsBetter: boolean,
  seed = BOOTSTRAP_SEED,
): DeltaEstimate | null {
  const usable = pairs.filter((pair) => Number.isFinite(pair.a) && Number.isFinite(pair.b));
  if (usable.length < 2) return null;
  const deltas = usable.map((pair) => pair.a - pair.b);
  const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;

  const random = mulberry32(seed);
  const means: number[] = [];
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample++) {
    let total = 0;
    for (let index = 0; index < deltas.length; index++) {
      total += deltas[Math.floor(random() * deltas.length)]!;
    }
    means.push(total / deltas.length);
  }
  means.sort((x, y) => x - y);
  const lower = means[Math.floor(0.025 * means.length)]!;
  const upper = means[Math.min(means.length - 1, Math.floor(0.975 * means.length))]!;

  let verdict: DeltaEstimate["verdict"] = "indistinguishable";
  if (lower > 0 && upper > 0) verdict = higherIsBetter ? "A better" : "B better";
  else if (lower < 0 && upper < 0) verdict = higherIsBetter ? "B better" : "A better";

  return { mean, ci95: [lower, upper], verdict, n: usable.length };
}
