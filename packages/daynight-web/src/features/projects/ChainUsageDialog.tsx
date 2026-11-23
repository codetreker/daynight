import { useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isTopOverlay } from '../../app/overlay';
import { useI18n } from '../../i18n/LocaleProvider';
import { DetailFrame, useDetailOverlay } from '../task-detail/DetailFrame';
import { UsageAggregatePanel } from '../usage-aggregate/UsageAggregatePanel';

export const ChainUsageDialog = ({ projectId, projectName, anchor, title, pending, error, onRetry, unavailable, root, onClose, onRestoreFocus, onOpenTask }: {
  readonly projectId: string; readonly projectName: string; readonly anchor: string; readonly title: string;
  readonly pending: boolean; readonly error: unknown; readonly onRetry: () => void; readonly unavailable: boolean; readonly root: RefObject<HTMLElement | null>; readonly onClose: () => void;
  readonly onRestoreFocus: () => void; readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
}) => {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const close = useRef<HTMLButtonElement>(null);
  const heading = useId();
  useDetailOverlay({ root, initialFocus: close, modal: true, fullscreen: false, scope: `${projectId}/${anchor}`,
    blocked: () => false, onEscape: onClose, onRestoreFocus });
  return createPortal(<div className="task-detail-backdrop" onClick={event => {
    if (event.target === event.currentTarget && root.current !== null && isTopOverlay(root.current)) onClose();
  }}><DetailFrame root={root} modal headingId={heading} className="task-detail-dialog chain-usage-dialog">
    <header className="task-detail-header"><div><p className="chain-usage-project">{projectName}</p><h2 id={heading} className="task-detail-title">{zh ? 'Token 用量' : 'Token usage'} · {title}</h2></div>
      <button className="button task-detail-close" ref={close} type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}>×</button></header>
    <div className="task-detail-body"><div className="task-detail-panel task-detail-panel-usage">
      {pending ? error !== null ? <div role="alert"><p>{zh ? '无法确认任务链，请重试。' : 'Unable to confirm the task chain. Try again.'}</p><button className="button" type="button" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button></div> : <p role="status">{zh ? '正在确认任务链…' : 'Confirming task chain…'}</p> : unavailable ? <p role="alert">{zh ? '此用量范围已不可用。' : 'This usage scope is no longer available.'}</p> : <UsageAggregatePanel projectId={projectId} scope="chain" scopeId={anchor} onOpenTask={onOpenTask} />}
    </div></div>
  </DetailFrame></div>, document.body);
};
