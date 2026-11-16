import { NativeSelect } from '../../ui/native-select/NativeSelect';
import { stringifyAssistantTaskJson } from '../../api/assistant-tasks';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { listAssistantTaskItems, listAssistantTaskRecords, type AssistantTaskItem, type AssistantTaskRecord } from '../../api/assistant-tasks';
import type { BotDefinition } from '../../api/bots';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { AssistantTaskMarkdown } from './AssistantTaskProposalPanel';
import { useAssistantTaskContentMessages } from './assistant-task-messages';
import { useBotRead } from './useBotRead';

const kinds = ['fact', 'guess', 'action', 'unknown', 'question', 'answer', 'note'] as const;
export type AssistantTaskRecordsProps = { readonly taskId: string; readonly enabled: boolean; readonly bots?: readonly BotDefinition[]; readonly recordId?: string | null };
export function AssistantTaskRecords({ taskId, enabled, bots = [], recordId = null }: AssistantTaskRecordsProps) {
  const m = useAssistantTaskContentMessages();
  const [selection, setSelection] = useState({ taskId, itemId: '', pages: 1 });
  const [kind, setKind] = useState(''), [author, setAuthor] = useState('');
  const itemId = selection.taskId === taskId ? selection.itemId : '', pages = selection.taskId === taskId ? selection.pages : 1;
  const targetRecord = itemId === '' ? recordId : null;
  const loadItems = useCallback(async (scope: TaskCacheScope, signal: AbortSignal) => {
    const items = new Map<string, AssistantTaskItem>(), cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await listAssistantTaskItems(taskId, { limit: 200, ...(cursor ? { cursor } : {}) }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
      for (const item of page.items) { if (items.has(item.id)) throw new ApiError('protocol'); items.set(item.id, item); }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ApiError('protocol');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...items.values()];
  }, [taskId]);
  const loadRecords = useCallback(async (scope: TaskCacheScope, signal: AbortSignal) => {
    const records = new Map<string, AssistantTaskRecord>(), cursors = new Set<string>();
    let cursor: string | null = null, count = 0;
    do {
      const page = await listAssistantTaskRecords(taskId, { limit: 50, ...(itemId ? { itemId } : {}), ...(cursor ? { cursor } : {}) }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
      for (const entry of page.items) { if (records.has(entry.id)) throw new ApiError('protocol'); records.set(entry.id, entry); }
      count++; cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new ApiError('protocol');
      if (cursor) cursors.add(cursor);
    } while (cursor && (count < pages || targetRecord !== null && !records.has(targetRecord)));
    return { records: [...records.values()], nextCursor: cursor, pages: count };
  }, [taskId, itemId, pages, targetRecord]);
  const items = useBotRead(`assistant-task-items:${taskId}`, enabled, loadItems);
  const records = useBotRead(`assistant-task-records:${taskId}:${itemId}`, enabled, loadRecords);
  const referenced = useRef<string | null>(null);
  const region = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (recordId === null) return;
    // Following evidence selects that record independently of retained filters.
    referenced.current = null;
    setSelection({ taskId, itemId: '', pages: 1 }); setKind(''); setAuthor('');
  }, [taskId, recordId]);
  useEffect(() => {
    if (!enabled || !recordId || referenced.current === `${taskId}:${recordId}` || !records.value?.records.some(entry => entry.id === recordId)) return;
    const target = region.current?.querySelector<HTMLElement>(`[id="record-${recordId}"]`);
    if (target) { target.scrollIntoView?.({ block: 'center' }); target.focus({ preventScroll: true }); referenced.current = `${taskId}:${recordId}`; }
  }, [taskId, recordId, records.value, enabled]);
  const authors = new Set((records.value?.records ?? []).map(entry => entry.authorBotId ?? 'system'));
  const name = (id: string) => id === 'system' ? m.system : bots.find(bot => bot.id === id)?.name ?? m.unknownAssistant.replace('{id}', id);
  const filtered = (records.value?.records ?? []).filter(entry => (!kind || entry.kind === kind) && (!author || (entry.authorBotId ?? 'system') === author));
  const groups = new Map<string, AssistantTaskRecord[]>();
  for (const entry of filtered) { const key = entry.itemId ?? ''; const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group); }
  return <section ref={region} className="assistant-task-record-section" aria-label={m.records}>
    <div className="assistant-task-filters">
      <label>{m.item}<NativeSelect density="filter" value={itemId} onChange={event => setSelection({ taskId, itemId: event.target.value, pages: 1 })}><option value="">{m.allItems}</option>{(items.value ?? []).map(item => <option key={item.id} value={item.id}>{item.key}</option>)}</NativeSelect></label>
      <label>{m.kind}<NativeSelect density="filter" value={kind} onChange={event => setKind(event.target.value)}><option value="">{m.all}</option>{kinds.map(value => <option key={value} value={value}>{m[value]}</option>)}</NativeSelect></label>
      <label>{m.author}<NativeSelect density="filter" value={author} onChange={event => setAuthor(event.target.value)}><option value="">{m.allAuthors}</option>{[...authors].map(id => <option key={id} value={id}>{name(id)}</option>)}</NativeSelect></label>
      {itemId || kind || author ? <button className="button quiet" type="button" onClick={() => { setSelection({ taskId, itemId: '', pages: 1 }); setKind(''); setAuthor(''); }}>{m.clearFilters}</button> : null}
    </div>
    {items.error ? <div role="alert" className="notice error">{m.itemsError}<button className="button" type="button" disabled={!enabled || items.busy} onClick={items.refresh}>{m.retry}</button></div> : null}
    {records.error ? <div role="alert" className="notice error">{m.recordsError}<button className="button" type="button" disabled={!enabled || records.busy} onClick={records.refresh}>{m.retry}</button></div> : null}
    {records.value === null && records.error === null ? <p role="status">{m.loading}</p> : null}
    {records.value && filtered.length === 0 ? <p className="assistant-task-empty">{kind || author ? m.noMatches : m.noRecords}</p> : null}
    {targetRecord && records.value && records.value.nextCursor === null && !records.value.records.some(entry => entry.id === targetRecord) ? <p role="status">{m.recordMissing}</p> : null}
    {[...groups].map(([groupId, entries]) => {
      const item = items.value?.find(value => value.id === groupId);
      return <section className="assistant-task-panel" key={groupId}><header><h3>{groupId ? item?.key ?? groupId : m.general}</h3>{item ? <span className="assistant-task-badge">{m[item.state]}</span> : null}</header>
        <ol className="assistant-task-records">{entries.map(entry => <li id={`record-${entry.id}`} tabIndex={-1} key={entry.id} className="assistant-task-record">
          <header><span className="assistant-task-badge" data-kind={entry.kind}>{m[entry.kind]}</span><span>{name(entry.authorBotId ?? 'system')}</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString(m.locale)}</time></header><AssistantTaskMarkdown text={entry.text} />
          {entry.refs !== null && stringifyAssistantTaskJson(entry.refs) !== '[]' && stringifyAssistantTaskJson(entry.refs) !== '{}' ? <details><summary>{m.references}</summary><pre className="assistant-task-rules">{stringifyAssistantTaskJson(entry.refs, 2)}</pre></details> : null}
        </li>)}</ol>
      </section>;
    })}
    {records.value?.nextCursor ? <><p className="assistant-task-meta">{m.loadedOnly}</p><button className="button" type="button" disabled={!enabled || records.busy} onClick={() => setSelection({ taskId, itemId, pages: records.value!.pages + 1 })}>{m.moreRecords}</button></> : null}
  </section>;
}
