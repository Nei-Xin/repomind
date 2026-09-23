/** Keep request cancellation connected to fetch and response-body consumption. */
export function upstreamSignal(clientSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return timeoutMs > 0
    ? AbortSignal.any([clientSignal, AbortSignal.timeout(timeoutMs)])
    : clientSignal;
}

/** Cancel even a pending read, including both branches when placed before tee(). */
export function cancellableStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onCancel?: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let stopped = false;
  let abort: () => void;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const cancelReader = async (reason: unknown) => {
    try {
      await reader.cancel(reason);
    } catch {
      // The source may already have failed. Preserve the original outcome.
    } finally {
      reader.releaseLock();
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (stopped) return;
        stopped = true;
        cleanup();
        controller.error(signal.reason);
        void cancelReader(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          stopped = true;
          cleanup();
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (stopped) return;
        stopped = true;
        cleanup();
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (stopped) return;
      stopped = true;
      cleanup();
      const error = reason ?? new Error("Client cancelled stream");
      onCancel?.(error);
      await cancelReader(error);
    },
  }, { highWaterMark: 0 });
}
