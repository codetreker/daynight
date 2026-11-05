import { useLayoutEffect, useRef, useState } from "react";
import type { TaskCacheScope } from "../task-cache/TaskCacheProvider";

export const TeamIdCopy = ({ value, admission, active, zh }: { readonly value: string; readonly admission: TaskCacheScope; readonly active: boolean; readonly zh: boolean }) => {
  const [state, setState] = useState<"idle" | "pending" | "copied" | "failed">("idle");
  const generation = useRef(0), pending = useRef(false);
  useLayoutEffect(() => {
    generation.current++; pending.current = false; setState("idle");
    return () => { generation.current++; pending.current = false; };
  }, [value, admission]);
  const copy = async () => {
    if (!active || admission.isInvalidated || admission.signal.aborted || pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setState("pending");
    let outcome: "copied" | "failed";
    try { await navigator.clipboard.writeText(value); outcome = "copied"; }
    catch { outcome = "failed"; }
    try {
      await admission.ready(admission.signal);
      if (request === generation.current && !admission.isInvalidated && !admission.signal.aborted) setState(outcome);
    } catch { /* The owning identity was invalidated before publication. */ }
    finally { if (request === generation.current) pending.current = false; }
  };
  const label = zh ? "复制 Team ID" : "Copy Team ID";
  return <>
    <div className="team-settings-id"><span>{value}</span><button className="button team-id-copy" type="button" aria-label={label} title={label} aria-disabled={!active || state === "pending"} onClick={() => { void copy(); }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg>
    </button></div>
    {state === "copied" && <div className="notice success team-id-notice" role="status">{zh ? "已复制" : "Copied"}</div>}
    {state === "failed" && <div className="notice error team-id-notice" role="alert">{zh ? "无法复制，请手动选择 Team ID 复制。" : "Clipboard unavailable. Select and copy the Team ID manually."}</div>}
  </>;
};
