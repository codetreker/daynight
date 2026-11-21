import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, listProjects } from '../../api/client';
import { assistantTaskInboxUrl, type AssistantTask } from '../../api/assistant-tasks';
import type { Project } from '../../api/types';
import { getWebhook, listWebhooks, type WebhookActiveEndpoint, type WebhookAdmission, type WebhookEventType, type WebhookOwner, type WebhookSubscriptionInput } from '../../api/webhooks';
import { webhookUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { WebhookIntentController, type WebhookIntentInput, type WebhookIntentState } from '../webhook-intents/controller';
import { useWebhookMessages } from '../webhooks/messages';

const en = {
  title: 'Daynight event subscription',
  intro: 'Choose projects and the event types for each project. Daynight delivers matching events to this inbox through your personal Webhook endpoint whose target is the token-free inbox URL.',
  projects: 'Projects', noProjects: 'No accessible projects', save: 'Save subscription', create: 'Create subscription',
  invalid: 'Select at least one project and at least one event type for each selected project.',
  enabled: 'Enabled', paused: 'Paused', manage: 'Manage on the Webhooks page', webhooks: 'Open Webhooks',
  pausedNotice: 'This endpoint is paused, so no events are delivered to the inbox. Saving the subscription keeps it paused; resume it on the Webhooks page.',
  lifecycle: 'Pause, resume, delete and other endpoint management are on the Webhooks page.',
  unknown: 'The result of the Webhook change is unknown. Check the original operation before making another change.', check: 'Check operation',
  error: 'The Webhook request failed.', conflict: 'This subscription changed elsewhere, so your change was not saved. Reload to discard your edits and load the current configuration.', reload: 'Reload',
  exists: 'A subscription for this inbox was already created elsewhere, so your change was not saved. Reload to discard your edits and load it.',
  loadError: 'Could not load Webhook subscriptions.', retry: 'Retry', loading: 'Loading…',
  endpointName: 'Assistant inbox',
  eventsFor: (project: string) => `Event types for ${project}`,
};
const zh: typeof en = {
  title: 'Daynight 事件订阅',
  intro: '选择项目，并为每个项目选择事件类型。Daynight 通过一个属于你本人的 Webhook 端点，把匹配的事件投递到这个收件箱；端点目标是不含令牌的收件箱地址。',
  projects: '项目', noProjects: '没有可访问项目', save: '保存订阅', create: '创建订阅',
  invalid: '请至少选择一个项目，并为每个选中的项目至少选择一类事件。',
  enabled: '已启用', paused: '已暂停', manage: '在 Webhook 页面管理', webhooks: '打开 Webhook 页面',
  pausedNotice: '这个端点已暂停，事件不会投递到收件箱。保存订阅不会恢复投递；请在 Webhook 页面恢复。',
  lifecycle: '暂停、恢复、删除等端点管理在 Webhook 页面进行。',
  unknown: 'Webhook 修改结果未知。再次修改前，请核对原操作。', check: '核对操作',
  error: 'Webhook 请求失败。', conflict: '这个订阅已在别处被修改，你的修改未保存。重新加载会放弃本地修改并读取最新配置。', reload: '重新加载',
  exists: '这个收件箱的订阅已在别处创建，你的修改未保存。重新加载会放弃本地修改并读取该订阅。',
  loadError: '无法读取 Webhook 订阅。', retry: '重试', loading: '正在加载…',
  endpointName: '助手收件箱',
  eventsFor: (project: string) => `${project} 的事件类型`,
};
const useMessages = () => useI18n().locale === 'zh-CN' ? zh : en;

const EVENT_TYPES: readonly WebhookEventType[] = ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted'];
const idle: WebhookIntentState = { phase: 'idle', prepared: null, result: null, error: null, reconciling: false, persistenceError: null };
const inertSubscribe = () => () => {};

/**
 * The creation key of the user's endpoint for one inbox. The Webhook service keeps a key unique among an owner's live
 * endpoints, so it identifies that endpoint regardless of its target and refuses a second create with `endpoint_exists`.
 */
export const inboxClientKey = (inboxId: string): string => `assistant-task-inbox:${inboxId}`;

/** The event types chosen for each selected project, keyed by project id. An unselected project has no key. */
type Selection = Readonly<Record<string, readonly WebhookEventType[]>>;
// Each project shows the union of its subscriptions' events. A project may hold several independent subscriptions; it
// appears once.
const selectionOf = (endpoint: WebhookActiveEndpoint | null): Selection => {
  const result: Record<string, WebhookEventType[]> = {};
  for (const item of endpoint?.subscriptions ?? []) result[item.projectId] = EVENT_TYPES.filter(event => result[item.projectId]?.includes(event) || item.eventTypes.includes(event));
  return result;
};
const serverCode = (error: unknown, code: string) => error instanceof ApiError && error.kind === 'server' && error.code === code;
const errorCode = (error: unknown) => error instanceof ApiError && error.code ? ` ${error.code}` : '';

type Directory = { readonly projects: readonly Project[]; readonly endpoint: WebhookActiveEndpoint | null };

const pages = async <T,>(read: (cursor: string | null) => Promise<{ readonly items: readonly T[]; readonly nextCursor: string | null }>): Promise<T[]> => {
  const items: T[] = [], seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) { if (seen.has(cursor)) throw new ApiError('protocol'); seen.add(cursor); }
  } while (cursor !== null);
  return items;
};
const webhookAdmission = (scope: TaskCacheScope): WebhookAdmission => ({ userId: scope.userId, onPrincipalMismatch: scope.principalMismatch, ready: signal => scope.ready(signal) });

/** Reads the accessible projects and the user's personal endpoint created for the inbox, if any. */
async function loadDirectory(scope: TaskCacheScope, clientKey: string, signal: AbortSignal): Promise<Directory> {
  const admission = webhookAdmission(scope), personal: WebhookOwner = { kind: 'personal', id: scope.userId };
  const projects = await pages(cursor => listProjects({ limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }));
  const summaries = await pages(cursor => listWebhooks(personal, { clientKey, limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, admission));
  // The service keeps the key unique among live endpoints, so more than one match breaks its contract.
  if (summaries.length > 1) throw new ApiError('protocol');
  const detail = summaries[0] === undefined ? null : await getWebhook(personal, summaries[0].id, signal, admission);
  return { projects, endpoint: detail?.lifecycle === 'active' && detail.clientKey === clientKey ? detail : null };
}

/**
 * Creates or edits the user's personal outbound Webhook subscription for one assistant task inbox. The inbox and the
 * endpoint are independent resources; the parent mounts this panel once per inbox id. The endpoint is created with the
 * inbox's creation key and found again by it.
 *
 * Concurrency and policy belong to the Webhook service. An edit is submitted with the endpoint version it was loaded at,
 * and the service rejects it with `version_conflict` if the endpoint changed meanwhile; a create is rejected with
 * `endpoint_exists` if another session already created the inbox's endpoint. Both offer a reload that discards the
 * edit. Target address, maintenance and project eligibility are decided by the service, whose error code the panel
 * shows as returned. Pausing, resuming, deleting and scope confirmation are on the Webhooks page.
 */
export function AssistantTaskSubscriptions({ task, inboxId, active, serviceOrigin = globalThis.location?.origin ?? '' }: {
  readonly task: AssistantTask; readonly inboxId: string; readonly active: boolean; readonly serviceOrigin?: string;
}) {
  const m = useMessages(), wm = useWebhookMessages(), scope = useTaskCacheScope(), heading = useId();
  const inboxUrl = assistantTaskInboxUrl(inboxId, serviceOrigin), clientKey = inboxClientKey(inboxId);
  const [data, setData] = useState<Directory | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null), [reload, setReload] = useState(0);
  // The user's selection while editing; null shows the loaded configuration. Every load discards it.
  const [draft, setDraft] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState<unknown>(null), [invalid, setInvalid] = useState(false);
  // A requested reload keeps the form locked until it succeeds. After a confirmed write the loaded configuration is
  // older than the service's, so editing it could submit a stale version or create a second endpoint; a failed read
  // stays locked and is recovered with Retry, never by writing again.
  const [refreshing, setRefreshing] = useState(false);
  // The parent keeps this panel mounted across tabs. Becoming active again loads only what has not been loaded yet, so
  // edits and a pending conflict survive a tab switch; only Retry, Reload or a confirmed change requests a new load.
  const loaded = useRef<{ readonly clientKey: string; readonly scope: TaskCacheScope; readonly reload: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    const last = loaded.current;
    if (last !== null && last.clientKey === clientKey && last.scope === scope && last.reload === reload) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    void (async () => {
      try {
        await scope.ready(signal);
        const value = await loadDirectory(scope, clientKey, signal);
        if (signal.aborted) return;
        loaded.current = { clientKey, scope, reload };
        setData(value); setDraft(null); setFailure(null); setInvalid(false); setLoadError(null); setRefreshing(false);
      } catch (error) { if (!signal.aborted) setLoadError(error); }
    })();
    return () => controller.abort();
  }, [active, clientKey, scope, reload]);

  const controller = useMemo(() => scope.isInvalidated ? null : new WebhookIntentController({ serviceOrigin, owner: { kind: 'personal', id: scope.userId }, admission: webhookAdmission(scope), signal: scope.signal }), [serviceOrigin, scope]);
  useEffect(() => () => controller?.dispose(), [controller]);
  const intent = useSyncExternalStore(controller?.subscribe ?? inertSubscribe, controller?.getSnapshot ?? (() => idle));
  // Inputs are disabled while a request or a requested reload is pending so the submitted choices are the ones on screen
  // and a late read cannot replace newer edits or outcomes.
  const locked = saving || refreshing || intent.phase === 'preparing' || intent.phase === 'submitting' || intent.phase === 'unknown' || intent.reconciling;
  const refresh = () => { setRefreshing(true); setReload(value => value + 1); };
  /**
   * Submits one change; a confirmed change reloads the configuration, a rejected one is shown with the edits kept. The
   * reload is requested before `saving` clears, so the form never becomes editable with the pre-write configuration.
   */
  const run = async (input: WebhookIntentInput) => {
    if (controller === null || locked) return;
    setFailure(null); setInvalid(false); setSaving(true);
    try {
      const state = await controller.submit(input);
      if (state.phase === 'rejected') setFailure(state.error);
      else if (state.phase === 'confirmed') refresh();
    } catch (error) { setFailure(error); }
    finally { setSaving(false); }
  };
  const reconcile = async () => { const state = await controller?.reconcile(); if (state?.phase === 'confirmed') refresh(); };

  const endpoint = data?.endpoint ?? null;
  const current = useMemo(() => selectionOf(endpoint), [endpoint]);
  const selection: Selection = draft ?? current;
  const edit = (change: (projects: Selection) => Selection) => { if (locked) return; setInvalid(false); setDraft(change(selection)); };
  // A project checked again starts from the events it had before the edit, so unchecking by mistake loses nothing.
  const toggleProject = (projectId: string, checked: boolean) => edit(projects => {
    const rest = Object.fromEntries(Object.entries(projects).filter(([id]) => id !== projectId));
    return checked ? { ...rest, [projectId]: current[projectId] ?? [] } : rest;
  });
  const toggleEvent = (projectId: string, event: WebhookEventType, checked: boolean) => edit(projects => {
    const events = projects[projectId] ?? [];
    return { ...projects, [projectId]: checked ? EVENT_TYPES.filter(item => item === event || events.includes(item)) : events.filter(item => item !== event) };
  });
  const save = () => {
    if (data === null) return;
    const chosen = Object.entries(selection);
    // Every checked project must keep at least one event type, so the submitted project list always equals the form's.
    if (chosen.length === 0 || chosen.some(([, events]) => events.length === 0)) { setInvalid(true); return; }
    // PATCH replaces the whole subscription list, so each existing subscription of a selected project is resubmitted under
    // its own id. An event removed from a project leaves every one of its subscriptions; an added event joins the
    // project's first subscription. A subscription left without events is dropped, and since the project keeps at least
    // one selected event, its first subscription then receives that event.
    const subscriptions = chosen.flatMap(([projectId, events]): WebhookSubscriptionInput[] => {
      const existing = endpoint?.subscriptions.filter(item => item.projectId === projectId) ?? [];
      if (existing.length === 0) return [{ id: null, projectId, eventTypes: events }];
      const before = current[projectId] ?? [], added = events.filter(event => !before.includes(event)), removed = before.filter(event => !events.includes(event));
      return existing.map((item, index) => ({ id: item.id, projectId, eventTypes: [...item.eventTypes.filter(event => !removed.includes(event)), ...(index === 0 ? added.filter(event => !item.eventTypes.includes(event)) : [])] }));
    }).filter(item => item.eventTypes.length > 0);
    // The service limits names to 100 code points; slicing code points never leaves a lone surrogate. A subscription
    // save omits `enabled`, so a paused endpoint stays paused.
    void run(endpoint === null
      ? { kind: 'endpoint.create', body: { clientKey, name: [...`${m.endpointName} · ${task.name}`].slice(0, 100).join(''), enabled: true, destination: { kind: 'http', adapterVersion: '1', configuration: { url: inboxUrl } }, subscriptions } }
      : { kind: 'endpoint.patch', endpointId: endpoint.id, ifVersion: endpoint.configVersion, destinationRevision: endpoint.destinationRevision, body: { subscriptions } });
  };

  // Projects the endpoint subscribes to but the user can no longer list keep their place in the form, so the submitted
  // list stays equal to it; the service decides whether they are still eligible.
  const projectNames = new Map<string, string>([
    ...(endpoint?.subscriptions.map(item => [item.projectId, item.projectName ?? item.projectId] as const) ?? []),
    ...(data?.projects.map(project => [project.id, project.name] as const) ?? []),
  ]);
  return <section className="assistant-task-panel assistant-task-subscriptions" aria-labelledby={heading}>
    <header><h3 id={heading}>{m.title}</h3></header>
    <p className="assistant-task-meta">{m.intro}</p>
    {loadError !== null ? <div className="notice error" role="alert"><p>{m.loadError}{errorCode(loadError)}</p><button className="button" type="button" onClick={refresh}>{m.retry}</button></div> : null}
    {data === null ? loadError === null ? <p role="status">{m.loading}</p> : null : <>
      {endpoint === null ? null : <div className="assistant-task-subscription-endpoint">
        <span><strong>{endpoint.name}</strong><span className="assistant-task-meta">{endpoint.enabled ? m.enabled : m.paused}</span></span>
        <a className="button" href={webhookUrl({ owner: 'personal', teamId: null, endpointId: endpoint.id, tab: 'configuration' })}>{m.manage}</a>
      </div>}
      {endpoint !== null && !endpoint.enabled ? <p className="notice warning" role="status">{m.pausedNotice}</p> : null}
      <form className="assistant-task-form assistant-task-subscription-form" onSubmit={event => { event.preventDefault(); save(); }}>
        <fieldset disabled={locked}><legend>{m.projects}</legend><div className="assistant-task-subscription-projects">
          {projectNames.size === 0 ? <span className="assistant-task-meta">{m.noProjects}</span> : [...projectNames].map(([id, name]) => {
            const events = selection[id];
            return <div key={id} className="assistant-task-subscription-project">
              <label><input type="checkbox" checked={events !== undefined} onChange={event => toggleProject(id, event.target.checked)} /><span>{name}</span></label>
              {events === undefined ? null : <div className="assistant-task-subscription-checks" role="group" aria-label={m.eventsFor(name)}>
                {EVENT_TYPES.map(event => <label key={event}><input type="checkbox" checked={events.includes(event)} onChange={changed => toggleEvent(id, event, changed.target.checked)} /><span>{wm.eventDescriptions[event]}</span></label>)}
              </div>}
            </div>;
          })}
        </div></fieldset>
        {invalid ? <p className="notice error" role="alert">{m.invalid}</p> : null}
        <div className="assistant-task-actions"><button className="button primary" type="submit" disabled={locked}>{endpoint === null ? m.create : m.save}</button></div>
      </form>
      <p className="assistant-task-meta">{m.lifecycle} <a href={webhookUrl({ owner: 'personal', teamId: null, endpointId: null, tab: 'configuration' })}>{m.webhooks}</a></p>
    </>}
    {intent.phase === 'unknown' && intent.prepared !== null ? <div className="notice warning" role="status"><p>{m.unknown}{errorCode(intent.error)}</p><code>{intent.prepared.operationId}</code><button className="button" type="button" disabled={intent.reconciling} onClick={() => void reconcile()}>{m.check}</button></div> : null}
    {failure === null ? null : serverCode(failure, 'version_conflict') || serverCode(failure, 'endpoint_exists')
      ? <div className="notice error" role="alert"><p>{serverCode(failure, 'endpoint_exists') ? m.exists : m.conflict}</p><button className="button" type="button" onClick={refresh}>{m.reload}</button></div>
      : <p className="notice error" role="alert">{m.error}{errorCode(failure)}</p>}
  </section>;
}
