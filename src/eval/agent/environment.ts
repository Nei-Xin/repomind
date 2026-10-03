import { spawn, type ChildProcess } from "node:child_process";

export interface EvaluationEnvironmentReport {
  startedAt: string;
  endedAt: string | null;
  sleepPrevention: {
    method: "caffeinate" | "none";
    status: "starting" | "active" | "released" | "unsupported" | "unavailable" | "interrupted";
    detail: string | null;
  };
  sampleIntervalMs: number;
  gapThresholdMs: number;
  /** Scheduling or clock interruptions, not proof of system sleep. */
  observationGaps: Array<{ from: string; to: string; elapsedMs: number }>;
}

export interface EvaluationEnvironment {
  sample(): number;
  snapshot(): EvaluationEnvironmentReport;
  stop(): Promise<void>;
}

export async function startEvaluationEnvironment(options: {
  platform?: NodeJS.Platform;
  launch?: () => ChildProcess;
  onUpdate?: (report: EvaluationEnvironmentReport) => void;
} = {}): Promise<EvaluationEnvironment> {
  let previous = Date.now();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  const mac = (options.platform ?? process.platform) === "darwin";
  const report: EvaluationEnvironmentReport = {
    startedAt: new Date(previous).toISOString(),
    endedAt: null,
    sleepPrevention: {
      method: mac ? "caffeinate" : "none",
      status: mac ? "starting" : "unsupported",
      detail: null,
    },
    sampleIntervalMs: 1_000,
    gapThresholdMs: 15_000,
    observationGaps: [],
  };
  const snapshot = (): EvaluationEnvironmentReport => structuredClone(report);
  const publish = (): void => options.onUpdate?.(snapshot());
  const sample = (): number => {
    if (report.endedAt !== null) return report.observationGaps.length;
    const now = Date.now();
    const elapsedMs = now - previous;
    if (elapsedMs > report.sampleIntervalMs + report.gapThresholdMs || elapsedMs < 0) {
      report.observationGaps.push({
        from: new Date(previous).toISOString(), to: new Date(now).toISOString(), elapsedMs,
      });
      publish();
    }
    previous = now;
    return report.observationGaps.length;
  };
  publish();
  if (mac) {
    try {
      // -w also releases the assertion if the host exits without running finally.
      child = (options.launch ?? (() => spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
        stdio: "ignore", shell: false,
      })))();
      closed = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child.on("error", (error) => {
        report.sleepPrevention.status = "unavailable";
        report.sleepPrevention.detail = error.message;
        publish();
      });
      child.once("exit", (code, signal) => {
        if (!stopping && report.sleepPrevention.status !== "unavailable") {
          report.sleepPrevention.status = "interrupted";
          report.sleepPrevention.detail = `caffeinate exited: code=${code}, signal=${signal}`;
          publish();
        }
      });
      await new Promise<void>((resolve) => {
        child!.once("spawn", () => {
          report.sleepPrevention.status = "active";
          child!.unref();
          resolve();
        });
        child!.once("error", () => resolve());
      });
    } catch (error) {
      report.sleepPrevention.status = "unavailable";
      report.sleepPrevention.detail = error instanceof Error ? error.message : String(error);
    }
  }
  publish();
  const timer = setInterval(sample, report.sampleIntervalMs);
  timer.unref();
  return {
    sample,
    snapshot,
    stop: () => stopPromise ??= (async () => {
      sample();
      stopping = true;
      clearInterval(timer);
      if (child && child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => child!.kill("SIGKILL"), 2_000);
        try { await closed; } finally { clearTimeout(forceKill); }
      }
      if (report.sleepPrevention.status === "active") report.sleepPrevention.status = "released";
      report.endedAt = new Date().toISOString();
      publish();
    })(),
  };
}
