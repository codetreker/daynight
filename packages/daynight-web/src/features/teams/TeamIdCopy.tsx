import { useLayoutEffect, useRef, useState } from "react";
import { CopyButton } from "../../ui/copy-button/CopyButton";
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
    <div className="team-settings-id"><span>{value}</span><CopyButton className="team-id-copy" label={label} aria-disabled={!active || state === "pending"} onClick={() => { void copy(); }} /></div>
    {state === "copied" && <div className="notice success team-id-notice" role="status">{zh ? "已复制" : "Copied"}</div>}
    {state === "failed" && <div className="notice error team-id-notice" role="alert">{zh ? "无法复制，请手动选择 Team ID 复制。" : "Clipboard unavailable. Select and copy the Team ID manually."}</div>}
  </>;
};
