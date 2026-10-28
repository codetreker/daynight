import { useEffect, useState } from "react";
import { overviewProgress, type OverviewProgress } from "./overview-progress";
import { timestampNanoseconds } from "./task-visibility";
import type { GraphSnapshot } from "./useTaskGraph";

const emptyProgress: OverviewProgress = { chains: [], standalone: null, recentStandaloneIds: [], nextUpdateAt: null };

const snapshotTime = (snapshot: GraphSnapshot): bigint => {
  const reference = snapshot.observedAt === null ? BigInt(snapshot.localTime) * 1_000_000n : timestampNanoseconds(snapshot.observedAt);
  return reference + BigInt(Math.floor((performance.now() - snapshot.receivedMonotonic) * 1_000_000));
};

export const useOverviewProgress = (snapshot: GraphSnapshot | null, chainIds: readonly string[], standaloneIds: readonly string[], active: boolean) => {
  const [tick, setTick] = useState(0);
  const progress = snapshot === null ? emptyProgress : overviewProgress(snapshot.index, chainIds, standaloneIds, snapshotTime(snapshot));
  const nextUpdateAt = progress.nextUpdateAt;

  useEffect(() => {
    if (!active || nextUpdateAt === null || snapshot === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const refresh = () => { setTick((value) => value + 1); };
    const onVisibility = () => { cancel(); if (document.visibilityState !== "hidden") refresh(); };
    if (document.visibilityState !== "hidden") {
      const remaining = nextUpdateAt - snapshotTime(snapshot);
      const milliseconds = Math.max(0, Number((remaining + 999_999n) / 1_000_000n));
      timer = setTimeout(refresh, milliseconds);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancel(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [active, snapshot, chainIds, standaloneIds, nextUpdateAt, tick]);

  return progress;
};
