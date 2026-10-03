/** Keep scope, warnings, code blocks and remaining work in their original order. */
export function compactSolutionSummary(summary: string): string {
  return summary;
}

/**
 * Use the first complete sentence, without interpreting domain wording or
 * skipping an opening heading/condition to promote a later, unscoped claim.
 * Structured handoffs can supply a more useful complete constraint paragraph.
 */
export function solutionSummaryTitle(summary: string): string {
  const line = summary.split(/\r?\n/u).find((value) => value.trim())?.trim();
  if (!line || /^(?:#{1,6}\s|```|~~~|>)/u.test(line)) return "Completed solution";
  const text = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(/^\*\*(.+)\*\*$/u, "$1").replace(/^\*\*([^*]+)\*\*/u, "$1");
  const sentence = text.match(/^.*?[。！？!?](?:\s|$)|^.*?\.(?:\s|$)/u)?.[0]?.trim();
  return sentence && sentence.length <= 160 ? sentence : "Completed solution";
}

/** Omit a title only when the body already begins with that exact whole text. */
export function memoryTextWithoutDuplicateTitle(title: string, content: string): string {
  return content === title || (content.startsWith(title) && /^\s/u.test(content.slice(title.length)))
    ? content : `${title}\n${content}`;
}
