/** Wait for cleanup while allowing an abort to finish the owning operation. */
export const awaitAbortable = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  // Observe cleanup even when the signal was already aborted before this call.
  void work.catch(() => undefined);
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([work, aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
