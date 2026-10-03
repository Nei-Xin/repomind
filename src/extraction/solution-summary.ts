// Formatting only: never infer facts from the task or discard file, verification,
// limitation, or remaining-work statements. Evidence always keeps the raw text.
const COMPLETION = /^(?:Completed the (?:requested (?:task|changes)|coordination-only (?:change|cleanup)|coordination-only (?:[A-Za-z0-9][A-Za-z0-9._/-]*\s+){1,8}(?:change|cleanup|closeout))[.:]|已完成(?:本次任务|协调清理)[。！：]?)$/u;
const HANDOFF = /^(?:Preserved (?:decision for (?:the )?next maintainer|handoff decision for the separate [^:\n]+ follow-up|for (?:the )?next maintainer|the approved implementation for the follow-up|the durable contract for the follow-up)|Durable (?:[^:\n]+ )?(?:constraints|decisions|contract)(?: preserved)? for (?:the )?next maintainer|Durable contract for the follow-up(?: implementation)?|Handoff constraints to preserve for the [^:\n]+ follow-up|交接(?:决策|约束)|后续维护(?:决策|约束))[:：]/u;
const INLINE_LEAD_IN = /^(?:Preserved (?:decision for (?:the )?next maintainer|for (?:the )?next maintainer)|交接(?:决策|约束)|后续维护(?:决策|约束))[:：]\s*/u;
const CAUTION = /\b(?:warning|caution|obsolete|unsafe|unless|except|however|but|if|until|unverified)\b|警告|注意|仅当|除非|但是|未验证/iu;
const VERIFICATION = /^(?:Ran `[^`]+`|Verified `[^`]+`|Tests passed|Current tests pass): (?:all|tests?|passed|passing|failed|failing|skipped|cancelled|todo|errors?|`[^`]+`|[\d\s*().,:;—-])+$/u;

function unchangedFiles(sentence: string): boolean {
  const match = sentence.match(/^(?:No (.+) were (?:modified|changed)|Made no changes to (.+)|Made no (.+) changes|Left (.+) unchanged|(.+) (?:were|remain) unchanged)\.$/u);
  const subject = match?.slice(1).find((part) => part !== undefined);
  // Tokenize file subjects instead of a repeated alternation with overlapping words.
  return subject !== undefined && subject.replace(/`[^`]+`/gu, 'file').split(/[,\s]+/u)
    .every((word) => /^(?:application|package|test|tests|code|file|files|all|other|tracked|and|or)$/u.test(word.toLowerCase()));
}

function withoutEmphasis(line: string): string {
  return /^\*\*.+\*\*$/u.test(line) ? line.slice(2, -2) : line;
}

function titleText(line: string): string {
  const text = withoutEmphasis(line);
  const partial = text.match(/^\*\*([^*]+):\*\*\s*(.*)$/u);
  // Strip only the subject-free contract label, never a warning or scoped label.
  return partial && /^(?:Durable contract for the follow-up(?: implementation)?)$/u.test(partial[1]!)
    ? (partial[2] || `${partial[1]}:`) : text;
}

function handoff(line: string): { text: string; inline: string } | undefined {
  const raw = withoutEmphasis(line.trim().replace(/^[-*]\s+/u, ''));
  const text = raw.replace(/^\*\*(?=Durable\b)/u, '').replace(/:\*\*(?=\s|$)/u, ':');
  const match = text.match(HANDOFF);
  return match ? { text, inline: text.slice(match[0].length).trim() } : undefined;
}

function bookkeeping(line: string): boolean {
  // Scope/condition continuations must not be detached from the following facts.
  if (/^\s/u.test(line) || CAUTION.test(line)) return false;
  const text = line.replace(/^[-*]\s+/u, '');
  return text.split(/(?<=[.!?。！？])\s+/u).every((sentence) =>
    /^Deleted (?:only )?`[^`]+`\.$/u.test(sentence)
    || /^Removed only `[^`]+`\.$/u.test(sentence)
    || unchangedFiles(sentence)
    || VERIFICATION.test(sentence)
    || /^`git diff --check` passes\.$/u.test(sentence)
    || /^Verified (?:that the deleted review file is the only tracked change|the diff contains only the intended deletion|the working-tree diff contains only the note deletion)\.$/u.test(sentence)
    || /^(?:Did not implement |仅删除|仅移除|运行了|未实现).+/u.test(sentence));
}

/** Conservative layout cleanup for new solution memories; Evidence stays raw. */
export function compactSolutionSummary(summary: string): string {
  // Quoted/code layouts need their original context, rather than being moved across bookkeeping.
  if (/^\s*(?:```|~~~|>)/mu.test(summary)) return summary;
  const lines = summary.split(/\r?\n/u);
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const candidates = lines.flatMap((line, index) => handoff(line) ? [index] : []);
  if (candidates.length !== 1) return summary;
  const start = candidates[0]!;
  if (/^\s/u.test(lines[start]!)) return summary;
  const prefix = lines.slice(0, start);
  // Only a standalone opening completion may be removed, never an inline fact.
  if (COMPLETION.test(prefix[0] ?? '') && !prefix[1]?.trim()) prefix.shift();
  if (!prefix.every((line) => !line.trim() || bookkeeping(line))) return summary;

  const isList = /^[-*]\s+/u.test(lines[start]!);
  // Keep the entire suffix together: later caveats may qualify the handoff,
  // including Markdown list continuations and remaining-work statements.
  const selected = lines.slice(start);
  const marker = handoff(selected[0]!)!;
  const firstBody = selected.slice(1).find((line) => line.trim());
  const bodyBullet = isList ? /^ {2,}[-*]\s+/u : /^\s*[-*]\s+/u;
  if (!marker.inline && (!firstBody || !bodyBullet.test(firstBody) || bookkeeping(firstBody.trim()))) return summary;
  // Strip only subject-free inline lead-ins. Keep headings that scope a list.
  if (!isList && marker.inline && INLINE_LEAD_IN.test(marker.text)) {
    selected[0] = marker.text.replace(INLINE_LEAD_IN, '');
  }
  return [selected, prefix]
    .map((part) => part.join('\n').trim()).filter(Boolean).join('\n\n');
}

/** Take the first complete statement, ignoring headings and generic completion. */
export function solutionSummaryTitle(summary: string): string {
  let fenced = false;
  for (const value of summary.split(/\r?\n/u)) {
    const line = value.trim();
    if (/^(?:```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line || /^#{1,6}\s/u.test(line)) continue;
    const text = titleText(line.replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+)/u, '').trim());
    if (!text || COMPLETION.test(text)) continue;
    if (/[:：]$/u.test(text)) {
      if (/^(?:Warning|Caution|Only|If|When|Unless|警告|注意|仅|如果|当)/iu.test(text)) return 'Completed solution';
      continue;
    }
    const sentence = text.match(/^.*?[。！？!?](?:\s|$)|^.*?\.(?:\s|$)/u)?.[0]?.trim() ?? text;
    // Never skip an overlong warning/condition to promote a later unscoped fact.
    return sentence.length <= 160 ? sentence : 'Completed solution';
  }
  return 'Completed solution';
}

/** Omit a title only when the body already begins with that exact whole text. */
export function memoryTextWithoutDuplicateTitle(title: string, content: string): string {
  return content === title || (content.startsWith(title) && /^\s/u.test(content.slice(title.length)))
    ? content : `${title}\n${content}`;
}
