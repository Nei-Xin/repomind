import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { AgentProcessExecutor } from "./types.js";

const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

const round = (value: number): number => Math.round(value * 1000) / 1000;

function appendLimited(current: string, chunk: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current, "utf8") >= MAX_CAPTURE_BYTES) return { value: current, truncated: true };
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= MAX_CAPTURE_BYTES) return { value: combined, truncated: false };
  return { value: Buffer.from(combined, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8"), truncated: true };
}

export const executeAgentProcess: AgentProcessExecutor = (request) => new Promise((resolvePromise) => {
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let aborted = false;
  let spawnError: string | undefined;
  let settled = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = (reason: "timeout" | "abort"): void => {
    if (settled) return;
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
    forceKill.unref();
  };
  const timeout = setTimeout(() => stop("timeout"), request.timeoutMs);
  timeout.unref();
  const abort = (): void => stop("abort");
  if (request.signal?.aborted) abort();
  else request.signal?.addEventListener("abort", abort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const appended = appendLimited(stdout, chunk);
    stdout = appended.value;
    stdoutTruncated ||= appended.truncated;
    request.onStdout?.(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    const appended = appendLimited(stderr, chunk);
    stderr = appended.value;
    stderrTruncated ||= appended.truncated;
    request.onStderr?.(chunk);
  });
  child.on("error", (error) => { spawnError = error.message; });
  child.on("close", (exitCode, signal) => {
    settled = true;
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    request.signal?.removeEventListener("abort", abort);
    resolvePromise({
      exitCode,
      signal,
      stdout,
      stderr,
      durationMs: round(performance.now() - started),
      timedOut,
      aborted,
      stdoutTruncated,
      stderrTruncated,
      ...(spawnError ? { error: spawnError } : {}),
    });
  });
});
