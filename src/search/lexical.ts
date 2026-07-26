/**
 * Lexical helpers shared by the memory index, the search query builder, and
 * the benchmark arms. Keeping them here rather than inside the core is what
 * makes the benchmark's lexical baselines structurally identical to RepoMind's
 * own retrieval: an arm cannot drift into a strawman without changing the code
 * production search runs on.
 */

// Ideographic scripts that SQLite's unicode61 tokenizer does not segment: it
// classifies these as letters, so a whole run collapses into one token and a
// substring query can never match it.
const CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/gu;
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;

/**
 * Expands ideographic runs into overlapping bigrams so unicode61 sees several
 * short tokens instead of one long one. "单元测试" becomes "单元 元测 测试",
 * which the same expansion applied to a query can then match.
 */
export function cjkBigrams(text: string): string[] {
  const grams: string[] = [];
  for (const [run] of text.matchAll(CJK_PATTERN)) {
    if (run.length === 1) {
      grams.push(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index++) grams.push(run.slice(index, index + 2));
  }
  return grams;
}

export function containsCjk(text: string): boolean {
  return CJK_CHAR.test(text);
}

/** Splits camelCase, snake_case, kebab-case, and paths into separate terms. */
function splitIdentifiers(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[\\/_\-.]+/g, " ");
}

/**
 * The indexed form of a memory: the raw text, plus identifier-split variants,
 * plus ideographic bigrams. Stored in `memory_fts.search_tokens`.
 */
export function searchTokens(title: string, content: string, tags: string[], files: string[]): string {
  const raw = [title, content, ...tags, ...files].join(" ");
  const parts = [raw, splitIdentifiers(raw)];
  const grams = cjkBigrams(raw);
  if (grams.length) parts.push(grams.join(" "));
  return parts.join(" ").toLowerCase();
}

/** The terms a lexical retriever would index or query, after all splitting. */
export function lexicalTerms(text: string): string[] {
  const expanded = `${text} ${splitIdentifiers(text)} ${cjkBigrams(text).join(" ")}`;
  return expanded
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Builds an FTS5 MATCH expression as an OR of quoted terms. Ideographic words
 * are expanded to bigrams so they match the indexed form. Returns null when the
 * query carries no usable term, which callers must treat as "no FTS pass"
 * rather than as an empty match.
 */
export function buildMatchExpression(query: string): string | null {
  const terms: string[] = [];
  for (const word of query.split(/\s+/u)) {
    const cleaned = word.replace(/["'*:^()]/g, "");
    if (!cleaned) continue;
    if (containsCjk(cleaned)) {
      terms.push(...cjkBigrams(cleaned));
      // Keep any non-ideographic remainder, e.g. "SQLite扩展" -> "SQLite".
      const residue = cleaned.replace(CJK_PATTERN, " ").trim();
      for (const part of residue.split(/\s+/u)) if (part) terms.push(part);
    } else {
      terms.push(cleaned);
    }
  }
  const unique = [...new Set(terms.filter(Boolean))];
  if (!unique.length) return null;
  return unique.map((term) => `"${term}"`).join(" OR ");
}
