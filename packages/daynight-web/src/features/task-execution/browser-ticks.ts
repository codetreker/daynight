const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export const subscribeBrowserClock = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (timer === null) timer = setInterval(() => { for (const tick of [...listeners]) tick(); }, 1_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
  };
};
