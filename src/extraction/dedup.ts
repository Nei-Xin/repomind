const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "must", "should", "shall", "will", "would", "repository", "memory",
]);
const NEGATIONS = new Set(["not", "no", "never", "cannot", "can't", "wont", "won't"]);

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replaceAll(/[^\p{L}\p{N}.%']+/gu, " ").split(/\s+/u)
    .filter(Boolean)
    .map((token) => NEGATIONS.has(token) ? "__negation__" : stem(token))
    .filter((token) => !STOP_WORDS.has(token)));
}

function numbers(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/\b\d+(?:\.\d+)?%?/gu) ?? [])].sort();
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function extractionContentSimilarity(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size && !rightTokens.size) return 1;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

/** Conservative cross-run deduplication for model wording/type drift. Identity
 * still requires the caller to match title and scope exactly. */
export function equivalentExtractionContent(left: string, right: string): boolean {
  if (!sameValues(numbers(left), numbers(right))) return false;
  const leftNegated = tokens(left).has("__negation__");
  const rightNegated = tokens(right).has("__negation__");
  if (leftNegated !== rightNegated) return false;
  return extractionContentSimilarity(left, right) >= 0.8;
}
