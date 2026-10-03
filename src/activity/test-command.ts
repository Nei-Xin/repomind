/**
 * Test-command recognition shared by every agent integration.
 *
 * A command's exit status only verifies a test when nothing after the test can
 * replace that status: `npm test | tail` reports tail's status, `npm test; echo`
 * reports echo's, and `npm test || true` always succeeds. Such commands still
 * count as (non-test) command evidence, but never as verified tests.
 */

type Operator = "&&" | "||" | "|" | ";" | "&" | null;

interface Segment {
  text: string;
  /** The control operator that follows this segment; null for the last one. */
  next: Operator;
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

/** Read one shell word without changing quoted arguments or escapes. */
function wordEnd(text: string, start: number): number {
  let quote: string | null = null;
  let index = start;
  for (; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && quote !== "'") { index++; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/u.test(char) || char === ">" || (char === "&" && text[index + 1] === ">")) break;
  }
  return index;
}

/** Remove only output redirections outside shell words, retaining input semantics. */
function commandWords(text: string): string[] {
  const words: string[] = [];
  for (let index = 0; index < text.length;) {
    if (/\s/u.test(text[index]!)) { index++; continue; }
    const redirection = /^(?:\d*>>?&(?:\d+|-)|\d*>>?|&>>?)/u.exec(text.slice(index));
    if (redirection) {
      index += redirection[0].length;
      if (!/>&(?:\d+|-)$/u.test(redirection[0])) {
        while (index < text.length && /\s/u.test(text[index]!)) index++;
        index = wordEnd(text, index);
      }
      continue;
    }
    const end = wordEnd(text, index);
    // Retain unsupported syntax verbatim rather than silently dropping it.
    if (end === index) { words.push(text[index]!); index++; continue; }
    words.push(text.slice(index, end));
    index = end;
  }
  return words;
}

function invocationWords(command: string): string[] {
  const words = commandWords(command);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] ?? "")) words.shift();
  if (["npx", "bunx"].includes(words[0] ?? "")) words.shift();
  else if (["pnpm", "yarn"].includes(words[0] ?? "") && ["exec", "dlx"].includes(words[1] ?? "")) words.splice(0, 2);
  if (words[0]) words[0] = words[0].replace(/^['"]|['"]$/gu, "").replaceAll("\\", "/").split("/").pop()!.replace(/\.exe$/iu, "");
  return words;
}

function packageScript(args: string[]): string | undefined {
  const valueFlags = new Set(["--workspace", "-w", "--prefix", "--dir", "--cwd", "-C", "--filter", "-F"]);
  let index = 0;
  while (args[index]?.startsWith("-")) {
    index += valueFlags.has(args[index]!) ? 2 : 1;
  }
  return args[index] === "run" ? args[index + 1] : args[index];
}

/** Match executable/subcommand positions, never filenames or echo arguments. */
export function isTestInvocation(command: string): boolean {
  const [head, ...args] = invocationWords(command);
  if (!head) return false;
  if (["vitest", "jest", "pytest", "py.test", "mocha", "unittest"].includes(head)) return true;
  if (["npm", "pnpm", "yarn", "bun"].includes(head)) {
    const script = packageScript(args);
    return /^(?:test|tests)(?::|$)/u.test(script ?? "");
  }
  if (head === "node") {
    // Stop before the script or -e/-p: their arguments cannot enable test mode.
    const valueFlags = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "--test-reporter", "--test-reporter-destination"]);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "--" || !arg.startsWith("-") || ["-e", "--eval", "-p", "--print"].includes(arg)) return false;
      if (/^--test(?:-only)?(?:=|$)/u.test(arg)) return true;
      if (valueFlags.has(arg)) index++;
    }
    return false;
  }
  if (["python", "python3"].includes(head)) return args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "");
  return ["go", "cargo", "dotnet", "mvn", "mvnw", "gradle", "gradlew"].includes(head) && args[0] === "test";
}

export function isBuildInvocation(command: string): boolean {
  const [head, ...args] = invocationWords(command);
  if (!head) return false;
  if (["npm", "pnpm", "yarn", "bun"].includes(head)) {
    return /^(?:build|typecheck|type-check|lint|check)(?::|$)/u.test(packageScript(args) ?? "");
  }
  if (["tsc", "eslint", "ruff", "mypy", "pyright", "biome", "make"].includes(head)) return true;
  const subcommands: Record<string, string[]> = {
    cargo: ["build", "check", "clippy"], go: ["build", "vet"],
    gradle: ["build", "assemble", "check"], gradlew: ["build", "assemble", "check"],
    mvn: ["compile", "package", "verify", "install"], mvnw: ["compile", "package", "verify", "install"],
    dotnet: ["build"], swift: ["build"],
  };
  return subcommands[head]?.includes(args[0] ?? "") ?? false;
}

const CONTEXT_STEP_PATTERN = /^(?:(?:cd|pushd)\s|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=|(?:source|\.)\s|(?:nvm|fnm)\s+use\b|conda\s+activate\b)/u;

function stepKey(segments: Segment[], index: number): string {
  const context = segments.slice(0, index)
    .filter((segment) => CONTEXT_STEP_PATTERN.test(segment.text))
    .map((segment) => commandWords(segment.text).join(" "))
    .filter((step) => !/^cd\s+(?:\.|'\.'|"\.")$/u.test(step));
  return [...context, commandWords(segments[index]!.text).join(" ")].join(" && ");
}

function supportedSyntax(text: string): boolean {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && quote !== "'") { index++; continue; }
    if (quote === "'") { if (char === "'") quote = null; continue; }
    if (char === "`" || (char === "$" && ["(", "{"].includes(text[index + 1] ?? ""))) return false;
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(" || char === ")" || text.slice(index, index + 2) === "<<") return false;
  }
  return quote === null;
}

/** A zero exit proves a step only on an unmasked, foreground && suffix. */
function canVerify(segments: Segment[], index: number): boolean {
  if (segments.at(-1)?.next !== null || !segments.slice(index, -1).every((segment) => segment.next === "&&")) return false;
  // Unsupported shell evaluation must not be promoted to verified evidence.
  if (segments.some((segment) => !supportedSyntax(segment.text))) return false;
  // A failed `cd` before `;` need not stop the test. Only carry contexts whose
  // entire path to this step is joined by &&, so success also proves setup.
  if (segments.slice(0, index).some((segment, position) =>
    CONTEXT_STEP_PATTERN.test(segment.text) && !segments.slice(position, index).every((part) => part.next === "&&"))) return false;
  let first = index;
  while (first > 0 && segments[first - 1]!.next !== ";") first--;
  return !segments.slice(first, index).some((segment) => segment.next === "||" || segment.next === "&");
}

export function verifyingTestCommand(command: string): string | null {
  const segments = splitCommandLine(command);
  for (let index = segments.length - 1; index >= 0; index--) {
    if (isTestInvocation(segments[index]!.text)) return canVerify(segments, index) ? stepKey(segments, index) : null;
  }
  return null;
}

export function isVerifyingTestCommand(command: string): boolean {
  return verifyingTestCommand(command) !== null;
}

/** Compatibility helper; recovery uses every step, not just the last one. */
export function verificationKey(command: string): string | null {
  return verificationSteps(command, null).at(-1)?.key ?? null;
}

interface VerificationStep {
  key: string;
  passed: boolean;
  outcome: "passed" | "failed" | "unknown" | "missing";
}

export function verificationSteps(command: string, exitCode: number | null): VerificationStep[] {
  const segments = splitCommandLine(command);
  return segments.flatMap((segment, index) => {
    if (!isTestInvocation(segment.text) && !isBuildInvocation(segment.text)) return [];
    const outcome: VerificationStep["outcome"] = exitCode === null ? "missing"
      : !canVerify(segments, index) ? "unknown" : exitCode === 0 ? "passed" : "failed";
    return [{ key: stepKey(segments, index), passed: outcome === "passed", outcome }];
  });
}

/** Shared ordered verification state for interactive and Host collectors. */
export function assessCommandVerification(commands: readonly {
  command: string; invokedAs?: string; exitCode: number | null;
}[]): {
  commands: Array<{ steps: VerificationStep[]; resolved: boolean }>;
  steps: number;
  unresolved: number;
} {
  const stepsByCommand = commands.map((command) => verificationSteps(command.invokedAs ?? command.command, command.exitCode));
  const latest = new Map<string, VerificationStep["outcome"]>();
  for (const steps of stepsByCommand) for (const step of steps) {
    // Masking provides no evidence either way. It cannot erase an earlier
    // failure or incomplete collection, and never counts as a verified pass.
    if (step.outcome !== "unknown" || !latest.has(step.key)) latest.set(step.key, step.outcome);
  }
  return {
    commands: stepsByCommand.map((steps) => ({ steps, resolved: steps.every((step) => latest.get(step.key) === "passed") })),
    steps: latest.size,
    unresolved: [...latest.values()].filter((outcome) => outcome === "failed" || outcome === "missing").length,
  };
}
