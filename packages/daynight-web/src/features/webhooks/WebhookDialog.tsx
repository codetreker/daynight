import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useBodyScrollLock } from "../../app/useBodyScrollLock";
import { WebhookIcon } from "./WebhookIcon";
import { useWebhookMessages } from "./messages";

export const WebhookDialog = ({ title, opener, children, footer, onClose }: {
  readonly title: string; readonly opener: HTMLElement | null; readonly children: ReactNode; readonly footer: ReactNode; readonly onClose: () => void;
}) => {
  const ref = useRef<HTMLDialogElement>(null), id = useId(), m = useWebhookMessages();
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const node = ref.current!, viewport = window.visualViewport;
    const resize = () => { node.style.setProperty("--webhook-viewport-height", `${viewport?.height ?? window.innerHeight}px`); node.style.setProperty("--webhook-viewport-top", `${viewport?.offsetTop ?? 0}px`); };
    resize(); viewport?.addEventListener("resize", resize); viewport?.addEventListener("scroll", resize); window.addEventListener("resize", resize);
    node.showModal(); node.querySelector<HTMLElement>("input, select, .dialog-footer button")?.focus({ preventScroll: true });
    return () => {
      viewport?.removeEventListener("resize", resize); viewport?.removeEventListener("scroll", resize); window.removeEventListener("resize", resize); node.close();
      queueMicrotask(() => {
        if (document.querySelector(".webhook-dialog[open]") !== null) return;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        else { const fallback = document.querySelector<HTMLElement>(".webhooks .heading .button.primary:not(:disabled), #main-content"); if (fallback !== null) fallback.focus({ preventScroll: true }); }
      });
    };
  }, [opener]);
  return <dialog ref={ref} className="webhook-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { if (event.key === "Escape" || event.key === "Tab") event.stopPropagation(); }}>
    <div className="modal-layout">
      <header className="dialog-header"><h2 id={id}>{title}</h2><button className="close-button" type="button" aria-label={m.close} onClick={onClose}><WebhookIcon name="close" size={18}/></button></header>
      <div className="dialog-body">{children}</div><footer className="dialog-footer">{footer}</footer>
    </div>
  </dialog>;
};
