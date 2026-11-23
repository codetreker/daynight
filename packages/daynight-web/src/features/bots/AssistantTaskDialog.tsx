import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { useAssistantTaskMessages } from './messages';
export function AssistantTaskDialog({ title, children, onClose }: { readonly title: string; readonly children: ReactNode; readonly onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId(), m = useAssistantTaskMessages();
  useBodyScrollLock(true);
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null, dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (opener?.isConnected && !opener.closest('[hidden],[inert]')) opener.focus(); };
  }, []);
  return <dialog ref={ref} className="auth-dialog assistant-task-dialog" aria-labelledby={id} onCancel={event => {event.preventDefault(); onClose();}}>
    <header className="dialog-header"><h2 id={id}>{title}</h2><AccountRefreshNotice /><button type="button" className="close-button" aria-label={m.close} onClick={onClose}>×</button></header>{children}
  </dialog>;
}
