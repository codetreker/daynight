import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import type { PullRequestProperty } from '../../api/types';

const pageSize = 100;

const isWebLink = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const noPullRequests: readonly PullRequestProperty[] = [];

export const TaskPullRequests = ({ pullRequests: value }: { readonly pullRequests: readonly PullRequestProperty[] | undefined }) => {
  const pullRequests = value === undefined ? noPullRequests : value;
  const { messages, format } = useI18n();
  const m = messages.inspection.pr;
  const [selection, setSelection] = useState({ collection: pullRequests, page: 0 });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const focusedElement = useRef<HTMLElement | null>(null);
  const pageId = useId();
  const page = selection.collection === pullRequests ? selection.page : 0;
  if (selection.collection !== pullRequests) {
    // Reset before commit so a replacement collection never displays an old page.
    setSelection({ collection: pullRequests, page: 0 });
  }
  const pageCount = Math.ceil(pullRequests.length / pageSize);
  const start = page * pageSize;
  const visible = pullRequests.slice(start, start + pageSize);

  useLayoutEffect(() => {
    const previous = focusedElement.current;
    if (previous !== null && (!previous.isConnected || (previous instanceof HTMLButtonElement && previous.disabled))) {
      if (selectRef.current !== null) selectRef.current.focus();
      else headingRef.current!.focus();
    }
  }, [pullRequests, page]);

  return (
    <section className="task-detail-section" aria-label={m.title}
      onFocusCapture={(event) => { focusedElement.current = event.target; }}
      onBlurCapture={(event) => {
        if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) focusedElement.current = null;
      }}>
      <h4 ref={headingRef} tabIndex={-1}>{m.heading({ count: format.number(pullRequests.length) })}</h4>
      {pageCount > 1 && (
        <div className="task-detail-pr-pagination">
          <p className="task-detail-pr-range" role="status" aria-live="polite" aria-atomic="true">{m.range({ start: format.number(start + 1), end: format.number(start + visible.length), total: format.number(pullRequests.length) })}</p>
          <div className="task-detail-pr-page-controls">
            <button className="button" type="button" disabled={page === 0}
              onClick={() => setSelection({ collection: pullRequests, page: page - 1 })}>{m.previous}</button>
            <label className="task-detail-pr-page-label" htmlFor={pageId}>{m.page}</label>
            <select className="task-detail-pr-page-select" id={pageId} ref={selectRef} aria-label={m.pageLabel} value={page}
              onChange={(event) => setSelection({ collection: pullRequests, page: Number(event.currentTarget.value) })}>
              {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{m.pageOption({ page: format.number(index + 1), total: format.number(pageCount) })}</option>)}
            </select>
            <button className="button" type="button" disabled={page === pageCount - 1}
              onClick={() => setSelection({ collection: pullRequests, page: page + 1 })}>{m.next}</button>
          </div>
        </div>
      )}
      {pullRequests.length === 0 ? <p className="task-detail-description">{m.empty}</p> : (
        <ul className="task-detail-pr-list">
          {visible.map(({ title, url }, index) => {
            const link = isWebLink(url);
            const value = url === '' ? m.emptyString : url;
            return (
              <li className="task-detail-pr" key={start + index}>
                <p className={`task-detail-pr-title${title === '' ? ' task-detail-pr-empty' : ''}`}>{title === '' ? m.emptyString : title}</p>
                <div className="task-detail-pr-url">
                  <span className="task-detail-pr-label">{m.url}</span>
                  {link
                    ? <a className="task-detail-pr-value" href={url} target="_blank" rel="noopener noreferrer">{value}</a>
                    : <span className={`task-detail-pr-value${url === '' ? ' task-detail-pr-empty' : ''}`}>{value}</span>}
                  {link && <span className="task-detail-pr-external" aria-hidden="true">↗</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
