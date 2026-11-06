import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { BotCreateForm } from './BotCreateForm';

export function BotCreateDialog(props: ComponentProps<typeof BotCreateForm>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const node = dialog.current!;
    const viewport = window.visualViewport;
    const resize = () => {
      node.style.setProperty('--bot-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      node.style.setProperty('--bot-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    node.showModal();
    node.querySelector<HTMLElement>('#bot-name, .bot-create-actions .primary')?.focus({ preventScroll: true });
    return () => { viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize); window.removeEventListener('resize', resize); node.close(); };
  }, []);
  return <dialog ref={dialog} className="bot-create-dialog" aria-labelledby="bot-create-title" onCancel={event => {
    event.preventDefault();
    // The active view owns Escape: browsing returns to the retained form and
    // a dispatched creation keeps its original request while cancellation is blocked.
    const node = dialog.current!;
    const target = node.contains(document.activeElement) && document.activeElement !== node ? document.activeElement : node.firstElementChild;
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }} onKeyDown={event => { if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation(); }}>
    <BotCreateForm {...props} onClose={() => { dialog.current?.close(); props.onClose(); }} />
  </dialog>;
}
