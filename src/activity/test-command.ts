/**
 * Test-command recognition shared by every agent integration.
 *
 * A command's exit status only verifies a test when nothing after the test can
 * replace that status: `npm test | tail` reports tail's status, `npm test; echo`
 * reports echo's, and `npm test || true` always succeeds. Such commands still
 * count as (non-test) command evidence, but never as verified tests.
 */

const RUNNER_PATTERN = /(^|\s)(test|tests|vitest|jest|pytest|unittest|mocha)(\s|$)|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmvn(?:w)?\s+test\b|\bgradle(?:w)?\s+test\b/iu;
// Node's built-in runner, including flags before --test
// (`node --experimental-strip-types --test`, `node --test-only`).
const NODE_TEST_PATTERN = /(^|[\s/\\])node(?:\.exe)?(?:\s+\S+)*?\s--test(?:-only)?(?:[=\s]|$)/iu;

type Operator = "&&" | "||" | "|" | ";" | "&" | null;

interface Segment {
  text: string;
  /** The control operator that follows this segment; null for the last one. */
  next: Operator;
}

/** True when a single simple command invokes a recognized test runner. */
export function isTestInvocation(command: string): boolean {
  return RUNNER_PATTERN.test(command) || NODE_TEST_PATTERN.test(command);
}

/**
 * Splits a shell command line on unquoted control operators. This is a
 * conservative approximation (no subshells or heredocs): it only has to find
 * where a test sits relative to operators that could mask its exit status.
 */
function splitCommandLine(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  const push = (next: Operator): void => {
    segments.push({ text: current.trim(), next });
    current = "";
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const following = command[index + 1];
    if (quote) {
      current += char;
      if (char === "\\" && quote === "\"" && following !== undefined) {
        current += following;
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\\" && following !== undefined) {
      current += char + following;
      index++;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "&" && following === "&") {
      push("&&");
      index++;
    } else if (char === "|" && following === "|") {
      push("||");
      index++;
    } else if (char === "|") {
      push("|");
      if (following === "&") index++; // `|&` pipes stderr too
    } else if (char === ";" || char === "\n") {
      push(";");
    } else if (char === "&") {
      const previous = command[index - 1];
      // `2>&1`, `<&3`, and `&>file` are redirections, not background jobs.
      if (previous === ">" || previous === "<" || following === ">") current += char;
      else push("&");
    } else {
      current += char;
    }
  }
  segments.push({ text: current.trim(), next: null });
  return segments.filter((segment, index, all) => segment.text || index === all.length - 1);
}

// Steps that change where or how the following test runs. They stay attached
// to the test; anything else before it (ls, cat, echo, builds) is dropped.
const CONTEXT_STEP_PATTERN = /^(?:(?:cd|pushd)\s|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*$|(?:source|\.)\s|(?:nvm|fnm)\s+use\b|conda\s+activate\b)/u;

/**
 * Returns the test invocation whose exit status is the command's, with the
 * context steps chained before it (`cd app && npm test`), or null when the
 * command does not verify a test. The status belongs to the test only when
 * every operator after the last test invocation is `&&`.
 */
export function verifyingTestCommand(command: string): string | null {
  const segments = splitCommandLine(command);
  let lastTest = -1;
  segments.forEach((segment, index) => {
    if (isTestInvocation(segment.text)) lastTest = index;
  });
  if (lastTest < 0) return null;
  const statusIsTests = segments.slice(lastTest, -1).every((segment) => segment.next === "&&")
    && segments[segments.length - 1]!.next === null;
  if (!statusIsTests) return null;
  let first = lastTest;
  while (
    first > 0
    && segments[first - 1]!.next === "&&"
    && CONTEXT_STEP_PATTERN.test(segments[first - 1]!.text)
  ) first--;
  return segments.slice(first, lastTest + 1).map((segment) => segment.text).join(" && ");
}

/** True when the command's exit status verifies a test (see verifyingTestCommand). */
export function isVerifyingTestCommand(command: string): boolean {
  return verifyingTestCommand(command) !== null;
}
