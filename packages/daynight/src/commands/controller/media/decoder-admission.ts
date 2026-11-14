type Waiter = { grant(): void; cancel(): void };

/** Only metadata waits; original files retain their existing durable media charge. */
export const controllerDecoderAdmission = () => {
  let active = false;
  const waiting: Waiter[] = [];
  return {
    acquire(signal: AbortSignal): Promise<() => void> {
      signal.throwIfAborted();
      // The image contract bounds each Controller to one decoder and 32 waiters.
      if (active && waiting.length >= 32) throw new Error("Controller image decoder queue capacity is unavailable.");
      return new Promise((resolve, reject) => {
        const grant = () => {
          active = true;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true; active = false;
            waiting.shift()?.grant();
          });
        };
        if (!active) { grant(); return; }
        const waiter: Waiter = {
          grant() { signal.removeEventListener("abort", waiter.cancel); grant(); },
          cancel() { waiting.splice(waiting.indexOf(waiter), 1); signal.removeEventListener("abort", waiter.cancel); reject(signal.reason); },
        };
        waiting.push(waiter); signal.addEventListener("abort", waiter.cancel, { once: true });
      });
    },
  };
};
