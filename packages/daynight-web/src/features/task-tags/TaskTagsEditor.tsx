import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { TaskDetail, TaskTag } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { useDirtyTaskDraft } from '../task-detail/TaskDraftNavigation';
import type { TaskMutationState } from '../task-detail/TaskDetailSession';
import { TagPicker } from './TagPicker';
import { TaskTagList } from './TaskTagList';
import { tagMessages } from './messages';
import './task-tags.css';

export const TaskTagsEditor = ({ projectId, detail, tags, canMutate, mutation, setTags, reconcile }: {
  readonly projectId: string; readonly detail: TaskDetail; readonly tags: readonly TaskTag[];
  readonly canMutate: boolean; readonly mutation: TaskMutationState;
  readonly setTags: (ids: readonly string[], version: bigint) => void; readonly reconcile: () => void;
}) => {
  const { locale } = useI18n(); const m = tagMessages[locale]; const zh = locale === 'zh-CN';
  const [draft, setDraft] = useState<readonly TaskTag[] | null>(null);
  const [version, setVersion] = useState(detail.version);
  const [creating, setCreating] = useState(false);
  const [nameDirty, setNameDirty] = useState(false);
  const baseline = useRef<readonly string[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const recovery = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const submittedIds = useRef<readonly string[]>([]);
  const previousOperation = useRef<TaskMutationState['operation']>(null);
  const close = () => { restoreFocus.current = true; setSubmitted(false); setCreating(false); setNameDirty(false); setDraft(null); };
  useLayoutEffect(() => {
    if (draft !== null || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = recovery.current && !recovery.current.disabled ? recovery.current : trigger.current?.disabled ? root.current : trigger.current;
    if (target?.isConnected) target.focus();
  }, [draft]);
  useDirtyTaskDraft({ isDirty: () => draft !== null && (creating || nameDirty || submitted || draft.length !== baseline.current.length || draft.some(tag => !baseline.current.includes(tag.id))), discard: close });
  const current = submitted && mutation.operation !== previousOperation.current && mutation.operation?.action === 'tags' ? mutation : null;
  useEffect(() => {
    if (draft === null || current?.phase !== 'confirmed' || current.reconciling || current.publicationPending || current.reconciliationError !== null) return;
    const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every(id => right.includes(id));
    if (!nameDirty && !creating && same(draft.map(tag => tag.id), submittedIds.current)) { close(); return; }
    if (same(detail.tags.map(tag => tag.id), submittedIds.current) && detail.version >= version) {
      setVersion(detail.version); baseline.current = submittedIds.current; setSubmitted(false);
    }
  }, [draft, current, detail, version, nameDirty, creating]);
  const unresolved = current?.phase === 'unknown' || current?.phase === 'conflict' || current?.phase === 'reconciled';
  const stale = draft !== null && detail.version !== version && (current === null || current.phase === 'refused' || current.phase === 'confirmed' && !current.reconciling && !current.publicationPending);
  return <div ref={root} tabIndex={-1} onKeyDown={event => { if (draft !== null && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <TaskTagList tags={tags} />
    <button className="button" type="button" ref={trigger} disabled={!canMutate || draft !== null} onClick={() => { setSubmitted(false); setVersion(detail.version); baseline.current = detail.tags.map(tag => tag.id); setDraft([...detail.tags]); }}>{zh ? '编辑标签' : 'Edit tags'}</button>
    {draft === null && mutation.operation?.action === 'tags' && (mutation.phase === 'unknown' || mutation.reconciliationError !== null) && <div role="alert"><p>{mutation.phase === 'unknown' || mutation.reconciledFrom === 'unknown' ? m.unknown : m.readError}</p>{mutation.reconciliationError !== null && <p>{m.readError}</p>}<button className="button" type="button" ref={recovery} disabled={mutation.reconciling} onClick={reconcile}>{mutation.reconciling ? m.checking : m.check}</button></div>}
    {draft !== null && <div className="task-tags-editor">
      <TagPicker projectId={projectId} value={draft} onChange={setDraft} canWrite={canMutate} onCreatingChange={setCreating} onNameDirty={setNameDirty} />
      {current !== null && current.phase === 'refused' && <p role="alert">{current.error instanceof ApiError && (current.error.status === 403 || current.error.code === 'permission_denied') ? m.denied : current.error instanceof ApiError && current.error.code === 'tag_not_found' ? (zh ? '所选标签已不存在，请检查选择。' : 'A selected tag no longer exists. Check the selection.') : current.error instanceof ApiError && current.error.code === 'resource_limit_exceeded' ? (zh ? '已达到标签容量上限。' : 'The tag capacity limit was reached.') : m.failed}</p>}
      {stale && <div role="alert"><p>{m.conflict}</p><p>{zh ? '当前已保存的标签：' : 'Currently saved tags:'}</p><TaskTagList tags={detail.tags} /><button className="button" type="button" onClick={() => { setVersion(detail.version); baseline.current = detail.tags.map(tag => tag.id); setSubmitted(false); }}>{zh ? '保留草稿并使用当前版本' : 'Keep draft and use current version'}</button></div>}
      {unresolved && <div role="alert"><p>{current.phase === 'unknown' || current.reconciledFrom === 'unknown' ? m.unknown : m.conflict}</p><p>{current.reconciling || current.reconciliationError !== null || current.phase === 'unknown' ? (zh ? '上次读取的标签：' : 'Last observed tags:') : (zh ? '当前已保存的标签：' : 'Currently saved tags:')}</p><TaskTagList tags={detail.tags} />{current.reconciliationError !== null && <p>{m.readError}</p>}<div className="tag-picker-actions"><button className="button" type="button" disabled={current.reconciling} onClick={reconcile}>{current.reconciling ? m.checking : m.check}</button>{(current.phase === 'reconciled' || current.phase === 'conflict' && !current.reconciling && current.reconciliationError === null && canMutate && detail.version !== version) && <button className="button" type="button" onClick={() => { setVersion(detail.version); baseline.current = detail.tags.map(tag => tag.id); setSubmitted(false); }}>{zh ? '保留草稿并使用当前版本' : 'Keep draft and use current version'}</button>}</div></div>}
      <div className="tag-picker-actions"><button className="button" type="button" onClick={close}>{m.cancel}</button><button className="button primary" type="button" disabled={!canMutate || current?.phase === 'pending' || creating || unresolved || stale} onClick={() => { setSubmitted(true); previousOperation.current = mutation.operation; submittedIds.current = [...new Set(draft.map(tag => tag.id))].sort(); setTags(submittedIds.current, version); }}>{current?.phase === 'pending' ? m.saving : m.save}</button></div>
    </div>}
  </div>;
};
