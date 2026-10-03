import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEvaluationEnvironment } from "../src/eval/agent/environment.js";

function fakeGuard() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, signalCode: null,
    unref: vi.fn(),
    kill: vi.fn((signal: string) => {
      child.emit("exit", null, signal);
      child.emit("close", null, signal);
      return true;
    }),
  });
  return { child, launch: () => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  } };
}

afterEach(() => vi.useRealTimers());

describe("evaluation environment", () => {
  it("releases the scoped assertion exactly once and preserves the final snapshot", async () => {
    const guard = fakeGuard();
    const monitor = await startEvaluationEnvironment({ platform: "darwin", launch: guard.launch });
    expect(monitor.snapshot().sleepPrevention.status).toBe("active");
    await Promise.all([monitor.stop(), monitor.stop()]);
    expect(guard.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(monitor.snapshot()).toMatchObject({ sleepPrevention: { status: "released" }, observationGaps: [] });
    expect(monitor.snapshot().endedAt).not.toBeNull();
  });

  it("records guard launch errors without failing the evaluation", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const monitor = await startEvaluationEnvironment({ platform: "darwin", launch: () => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    } });
    await monitor.stop();
    expect(monitor.snapshot().sleepPrevention).toMatchObject({ status: "unavailable", detail: "ENOENT" });
  });

  it("records premature guard loss rather than claiming successful protection", async () => {
    const guard = fakeGuard();
    const monitor = await startEvaluationEnvironment({ platform: "darwin", launch: guard.launch });
    guard.child.kill("SIGTERM");
    await monitor.stop();
    expect(monitor.snapshot().sleepPrevention.status).toBe("interrupted");
  });

  it("does not start a macOS command on another platform", async () => {
    const launch = vi.fn();
    const monitor = await startEvaluationEnvironment({ platform: "linux", launch });
    await monitor.stop();
    expect(launch).not.toHaveBeenCalled();
    expect(monitor.snapshot().sleepPrevention.status).toBe("unsupported");
  });

  it("captures missed sampling intervals and clock reversal, and stops sampling on cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const monitor = await startEvaluationEnvironment({ platform: "linux" });
    try {
      vi.advanceTimersByTime(5_000);
      expect(monitor.sample()).toBe(0);
      // Advance wall time without running timers, as during suspend or a blocked loop.
      vi.setSystemTime(new Date("2026-10-02T12:01:00Z"));
      expect(monitor.sample()).toBe(1);
      expect(monitor.snapshot().observationGaps[0]).toEqual({
        from: "2026-10-02T12:00:05.000Z", to: "2026-10-02T12:01:00.000Z", elapsedMs: 55_000,
      });
      vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
      expect(monitor.sample()).toBe(2);
      const copy = monitor.snapshot();
      copy.observationGaps.length = 0;
      expect(monitor.snapshot().observationGaps).toHaveLength(2);
    } finally { await monitor.stop(); }
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    expect(monitor.sample()).toBe(2);
  });
});
