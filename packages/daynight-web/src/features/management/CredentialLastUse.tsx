import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/LocaleProvider";

// All credential rows share this page clock; it never reads the server.
const Clock = createContext<number | null>(null);
export const CredentialClockProvider = ({ visible, children }: { readonly visible: boolean; readonly children: ReactNode }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const updateVisibility = () => {
      if (timer !== undefined) { clearInterval(timer); timer = undefined; }
      if (visible && document.visibilityState === "visible") {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 60_000);
      }
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => { document.removeEventListener("visibilitychange", updateVisibility); if (timer !== undefined) clearInterval(timer); };
  }, [visible]);
  return <Clock value={now}>{children}</Clock>;
};

// The API accepts up to nanosecond precision; Date.parse alone loses sub-millisecond ordering.
const timestampKey = (value: string): string => `${value.slice(0, 19)}.${(value.slice(19, -1).replace(/^\./, "")).padEnd(9, "0")}`;
export const latestCredentialUse = (previous: string | null, incoming: string | null): string | null => {
  if (previous === null) return incoming;
  if (incoming === null) return previous;
  return timestampKey(previous) > timestampKey(incoming) ? previous : incoming;
};

export const mergeCredentialUses = <T extends { readonly id: string; readonly lastUsedAt: string | null }>(previous: readonly T[] | null, incoming: readonly T[]): readonly T[] => {
  if (previous === null) return incoming;
  const old = new Map(previous.map(item => [item.id, item]));
  const merged = incoming.map(item => ({ ...item, lastUsedAt: latestCredentialUse(old.get(item.id)?.lastUsedAt ?? null, item.lastUsedAt) }));
  // Metadata alone must not reorder existing rows even if a response arrives in another order.
  const unchanged = merged.length === previous.length && merged.every(item => {
    const before = old.get(item.id);
    if (before === undefined) return false;
    return Object.keys(item).every(key => key === "lastUsedAt" || item[key as keyof T] === before[key as keyof T]);
  });
  if (!unchanged) return merged;
  const byId = new Map(merged.map(item => [item.id, item]));
  return previous.map(item => byId.get(item.id)!);
};

export const CredentialLastUse = ({ value }: { readonly value: string | null }) => {
  const { format, messages: { auth: { management: { account: m } } } } = useI18n();
  const now = useContext(Clock) ?? Date.now();
  if (value === null) return <p className="last-use-empty">{m.lastUsed}: {m.noUsageRecorded}</p>;
  const age = Math.max(0, now - Date.parse(value));
  const relative = age < 60_000 ? m.usageJustNow : age < 3_600_000 ? m.usageMinutes(Math.floor(age / 60_000)) : age < 86_400_000 ? m.usageHours(Math.floor(age / 3_600_000)) : m.usageDays(Math.floor(age / 86_400_000));
  const full = format.dateTime(value);
  return <details className="credential-last-use"><summary title={`${m.recordedTime}: ${full}`}>{m.lastUsed}: <time dateTime={value}>{relative}</time></summary><p className="full-time">{m.recordedTime}: <time dateTime={value}>{full}</time></p></details>;
};
