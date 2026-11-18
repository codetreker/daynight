import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const LastAdminLeaveButton = ({ label, reason, active }: { readonly label: string; readonly reason: string; readonly active: boolean }) => {
  const reasonId = useId();
  const button = useRef<HTMLButtonElement>(null), tip = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [dismissed, setDismissed] = useState(false);
  const open = active && (hovered || focused) && !dismissed;

  useLayoutEffect(() => {
    if (active) return;
    setHovered(false);
    setFocused(false);
    setDismissed(false);
  }, [active]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = button.current!.getBoundingClientRect(), bubble = tip.current!;
      const { width, height } = bubble.getBoundingClientRect();
      bubble.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
      bubble.style.top = `${Math.max(8, Math.min(anchor.bottom + height + 14 <= window.innerHeight ? anchor.bottom + 6 : anchor.top - height - 6, window.innerHeight - height - 8))}px`;
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, reason]);

  return <>
    <button ref={button} className="button quiet" type="button" aria-disabled="true" aria-describedby={reasonId}
      onPointerEnter={() => { setHovered(true); setDismissed(false); }} onPointerLeave={() => setHovered(false)}
      onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => setFocused(false)}>{label}</button>
    {createPortal(<span ref={tip} id={reasonId} role="tooltip" className="team-member-leave-tip" hidden={!open}>{reason}</span>, document.body)}
  </>;
};
