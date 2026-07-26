import type { ArmKey, ContextBundle, ContextRecord } from "./types.js";

/**
 * Documented heuristic, not a BPE count. Only ratios between arms are
 * meaningful, and the error is correlated with the arm because diffs and JSON
 * have a different characters-per-token ratio than prose — which is why every
 * bundle also publishes exact characters per record kind.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const REPO_KINDS = new Set(["repo_base", "repo_chunk"]);

/**
 * Packs whole records in the order given until the budget is exceeded. A record
 * is never cut in half: a half-quoted fact would score as present while being
 * useless to an agent.
 */
export function packToBudget(
  arm: ArmKey,
  records: ContextRecord[],
  budget: number,
  options: { capBound?: boolean; alpha?: number } = {},
): ContextBundle {
  const packed: ContextRecord[] = [];
  let repoTokens = 0;
  let memoryTokens = 0;
  let truncated = false;
  for (const record of records) {
    const tokens = approxTokens(record.text);
    const isRepo = REPO_KINDS.has(record.kind);
    const next = repoTokens + memoryTokens + tokens;
    if (Number.isFinite(budget) && next > budget) {
      truncated = true;
      continue;
    }
    packed.push(record);
    if (isRepo) repoTokens += tokens;
    else memoryTokens += tokens;
  }
  const charsByKind: Record<string, number> = {};
  let chars = 0;
  for (const record of packed) {
    charsByKind[record.kind] = (charsByKind[record.kind] ?? 0) + record.text.length;
    chars += record.text.length;
  }
  return {
    arm,
    records: packed,
    chars,
    charsByKind,
    repoTokens,
    memoryTokens,
    approxTokens: repoTokens + memoryTokens,
    truncated,
    capBound: options.capBound ?? false,
    ...(options.alpha === undefined ? {} : { alpha: options.alpha }),
  };
}
