import type { ReactNode, RefObject } from 'react';
import type { GraphDirection } from './layout';

type Fullscreen = { readonly active: boolean; readonly onToggle: () => void; readonly buttonRef: RefObject<HTMLButtonElement | null> };

export const TaskGraphToolbar = ({ title, summary, status, direction, onDirectionChange, directionLabel, horizontalLabel, verticalLabel, fullscreen, enterFullscreenLabel, exitFullscreenLabel, resetButton, onReset, resetLabel, notice }: {
  title: ReactNode;
  summary: ReactNode;
  status: ReactNode;
  direction: GraphDirection;
  onDirectionChange: ((direction: GraphDirection) => void) | undefined;
  directionLabel: string;
  horizontalLabel: string;
  verticalLabel: string;
  fullscreen: Fullscreen | undefined;
  enterFullscreenLabel: string;
  exitFullscreenLabel: string;
  resetButton: RefObject<HTMLButtonElement | null>;
  onReset: () => void;
  resetLabel: string;
  notice: string | undefined;
}) => <>
  <div className="graph-toolbar">
    <div className="graph-toolbar-summary">
      <span>{title}</span>
      <span className="graph-counts">{summary}</span>
      <span className="graph-hidden-prerequisites" role="status">{status}</span>
    </div>
    <div className="graph-toolbar-actions">
      <div className="graph-orientation" role="radiogroup" aria-label={directionLabel}>
        {(['horizontal', 'vertical'] as const).map((option) => <button key={option} type="button" role="radio" aria-checked={direction === option} tabIndex={direction === option ? 0 : -1}
          onClick={() => onDirectionChange?.(option)} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const next = option === 'horizontal' ? 'vertical' : 'horizontal';
            onDirectionChange?.(next);
            (event.currentTarget.parentElement?.querySelector(`[data-direction="${next}"]`) as HTMLButtonElement | null)?.focus();
          }} data-direction={option}><span aria-hidden="true">{option === 'horizontal' ? '⇢' : '⇣'}</span>{option === 'horizontal' ? horizontalLabel : verticalLabel}</button>)}
      </div>
      {fullscreen !== undefined && <button className="button graph-fullscreen-toggle" type="button" ref={fullscreen.buttonRef} onClick={fullscreen.onToggle}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d={fullscreen.active ? 'M4 9h5V4m6 0v5h5M4 15h5v5m6 0v-5h5' : 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'} />
        </svg>
        {fullscreen.active ? exitFullscreenLabel : enterFullscreenLabel}
      </button>}
      <button className="button graph-reset-overview" type="button" ref={resetButton} onClick={onReset}>{resetLabel}</button>
    </div>
  </div>
  {notice !== undefined && <p className="snapshot-notice graph-preference-notice" role="status">{notice}</p>}
</>;
