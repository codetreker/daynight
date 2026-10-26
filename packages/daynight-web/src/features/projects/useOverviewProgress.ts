import { useEffect, useState } from "react";
import { overviewProgress, overviewTimestamp } from "./overview-progress";
import type { GraphSnapshot } from "./useTaskGraph";

export const useOverviewProgress = (snapshot: GraphSnapshot, chainIds: readonly string[], standaloneIds: readonly string[], active: boolean) => {
  const [tick, setTick] = useState(0);
  const now = () => overviewTimestamp(snapshot.observedAt) + BigInt(Math.floor((performance.now() - snapshot.receivedMonotonic) * 1_000_000));
  const progress = overviewProgress(snapshot.index, chainIds, standaloneIds, now());
  const nextUpdateAt = progress.nextUpdateAt;

  useEffect(() => {
    if (!active || nextUpdateAt === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const refresh = () => { setTick((value) => value + 1); };
    const onVisibility = () => { cancel(); if (document.visibilityState !== "hidden") refresh(); };
    if (document.visibilityState !== "hidden") {
      const remaining = nextUpdateAt - now();
      const milliseconds = Math.max(0, Number((remaining + 999_999n) / 1_000_000n));
      timer = setTimeout(refresh, milliseconds);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancel(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [active, snapshot.observedAt, snapshot.receivedMonotonic, snapshot.index, chainIds, standaloneIds, nextUpdateAt, tick]);

  return progress;
};
