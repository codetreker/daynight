import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, listProjects } from '../../api/client';
import { assistantTaskInboxUrl, type AssistantTask } from '../../api/assistant-tasks';
import { listTeams, type Team } from '../../api/teams';
import type { Project } from '../../api/types';
import { getWebhook, listWebhooks, type WebhookActiveEndpoint, type WebhookAdmission, type WebhookEndpointSummary, type WebhookEventType, type WebhookOwner } from '../../api/webhooks';
import { webhookUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { WebhookIntentController, type WebhookIntentInput, type WebhookIntentState } from '../webhook-intents/controller';
import { useWebhookMessages } from '../webhooks/messages';

const en = {
  title: 'Daynight event subscription',
  intro: 'Choose projects and event types. Daynight delivers matching events to this inbox through a personal Webhook endpoint whose target is the token-free inbox URL.',
  local: 'This deployment is not served over public HTTPS. Outbound Webhooks only deliver to public HTTPS targets, so this inbox cannot subscribe to events from this deployment. External senders can still call the inbox directly.',
  projects: 'Projects', events: 'Event types', noProjects: 'No accessible projects', save: 'Save subscription', create: 'Create subscription',
  invalid: 'Select at least one project and one event type.', linked: 'Endpoints targeting this inbox', none: 'No Webhook endpoint targets this inbox yet.',
  personal: 'Personal', team: 'Team', enabled: 'Enabled', paused: 'Paused', open: 'Open', pause: 'Pause', delete: 'Delete',
  teamWarning: 'A Team endpoint targets this inbox. Team endpoints cannot pass the Daynight source check, so their deliveries are rejected for a missing token. Use the personal subscription here instead.',
  disabledWarning: 'The inbox is disabled. Deliveries to these endpoints are rejected and end. Pause or delete the endpoints that still target it.',
  retiredWarning: 'The inbox is disabled. These personal endpoints target an assistant inbox on this site; deliveries to a disabled inbox are rejected and end. Pause or delete the ones that targeted this inbox.',
  unknown: 'The result of the Webhook change is unknown. Check the original operation before making another change.', check: 'Check operation',
  error: 'The Webhook request failed.', loadError: 'Could not load Webhook subscriptions.', retry: 'Retry', loading: 'Loading…',
  endpointName: 'Assistant inbox',
};
const zh: typeof en = {
  title: 'Daynight 事件订阅',
  intro: '选择项目与事件类型。Daynight 通过一个属于你本人的 Webhook 端点，把匹配的事件投递到这个收件箱；端点目标是不含令牌的收件箱地址。',
  local: '当前部署未通过公网 HTTPS 提供服务。出站 Webhook 只投递到公网 HTTPS 目标，因此这个收件箱无法订阅本部署的事件；外部发送方仍可直接调用收件箱。',
  projects: '项目', events: '事件类型', noProjects: '没有可访问项目', save: '保存订阅', create: '创建订阅',
  invalid: '请至少选择一个项目和一类事件。', linked: '指向此收件箱的端点', none: '还没有 Webhook 端点指向这个收件箱。',
  personal: '个人', team: '团队', enabled: '已启用', paused: '已暂停', open: '打开', pause: '暂停', delete: '删除',
  teamWarning: '有团队端点指向这个收件箱。团队端点无法通过 Daynight 来源核验，其投递会因缺少令牌被拒绝。请改用这里的个人订阅。',
  disabledWarning: '收件箱已停用，投向这些端点的事件会被拒绝并结束。请暂停或删除仍指向它的端点。',
  retiredWarning: '收件箱已停用。以下个人端点指向本站的助手收件箱；投向已停用收件箱的事件会被拒绝并结束。请暂停或删除其中原本指向这个收件箱的端点。',
  unknown: 'Webhook 修改结果未知。再次修改前，请核对原操作。', check: '核对操作',
  error: 'Webhook 请求失败。', loadError: '无法读取 Webhook 订阅。', retry: '重试', loading: '正在加载…',
  endpointName: '助手收件箱',
};
const useMessages = () => useI18n().locale === 'zh-CN' ? zh : en;

const EVENT_TYPES: readonly WebhookEventType[] = ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted'];
const idle: WebhookIntentState = { phase: 'idle', prepared: null, result: null, error: null, reconciling: false, persistenceError: null };
const inertSubscribe = () => () => {};

/** Outbound delivery accepts only public HTTPS targets, so loopback and plain HTTP deployments cannot target their own inbox. */
export const canSelfSubscribe = (origin: string): boolean => {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return url.protocol === 'https:' && host !== 'localhost' && !host.endsWith('.localhost') && host !== '::1' && host !== '0.0.0.0' && !/^127\./.test(host);
};
/**
 * The inbox route and its Delivery target check accept only the exact inbox path, so a query string does not separate
 * endpoints but a trailing slash names a different, non-working target.
 */
export const targetsInbox = (target: string | null, inboxUrl: string): boolean => {
  if (target === null) return false;
  try {
    const left = new URL(target), right = new URL(inboxUrl);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch { return false; }
};

const INBOX_PATH = /^\/api\/v1\/assistant-task-inbox\/[^/]+\/*$/;
/** Matches any assistant inbox of this deployment; used when a disabled inbox no longer reports which id it had. */
export const targetsAnyInbox = (target: string | null, origin: string): boolean => {
  if (target === null) return false;
  try {
    const left = new URL(target);
    return left.origin === new URL(origin).origin && INBOX_PATH.test(left.pathname);
  } catch { return false; }
};

type TeamEndpoint = { readonly team: Team; readonly endpoint: WebhookEndpointSummary };
type Directory = { readonly projects: readonly Project[]; readonly personal: readonly WebhookActiveEndpoint[]; readonly team: readonly TeamEndpoint[] };

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

async function loadDirectory(scope: TaskCacheScope, matches: (target: string | null) => boolean, includeTeam: boolean, signal: AbortSignal): Promise<Directory> {
  const admission = webhookAdmission(scope), personal: WebhookOwner = { kind: 'personal', id: scope.userId };
  const projects = await pages(cursor => listProjects({ limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }));
  const summaries = await pages(cursor => listWebhooks(personal, { limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, admission));
  const linked = await Promise.all(summaries.filter(item => matches(item.destination.url)).map(item => getWebhook(personal, item.id, signal, admission)));
  const teams = includeTeam ? (await pages(cursor => listTeams(cursor, scope.userId, signal, scope.principalMismatch))).filter(team => team.kind === 'ordinary') : [];
  const team: TeamEndpoint[] = [];
  for (const entry of teams) {
    const owner: WebhookOwner = { kind: 'team', id: entry.id };
    // A Team endpoint the user cannot read is not something the user can act on; it does not block the personal subscription.
    const items = await pages(cursor => listWebhooks(owner, { limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, admission)).catch(error => { if (signal.aborted) throw error; return []; });
    team.push(...items.filter(item => matches(item.destination.url)).map(endpoint => ({ team: entry, endpoint })));
  }
  return { projects, personal: linked.filter((item): item is WebhookActiveEndpoint => item.lifecycle === 'active'), team };
}

/**
 * Personal outbound Webhook subscription for an assistant task inbox. The inbox and the endpoint are independent
 * resources: this panel only creates or edits the user's own endpoint, and disabling the inbox leaves endpoints in place.
 */
export function AssistantTaskSubscriptions({ task, inboxId, inboxEnabled, active, serviceOrigin = globalThis.location?.origin ?? '' }: {
  readonly task: AssistantTask; readonly inboxId: string | null; readonly inboxEnabled: boolean; readonly active: boolean; readonly serviceOrigin?: string;
}) {
  const m = useMessages(), wm = useWebhookMessages(), scope = useTaskCacheScope(), heading = useId();
  const selfSubscribe = canSelfSubscribe(serviceOrigin), inboxUrl = inboxId === null ? null : assistantTaskInboxUrl(inboxId, serviceOrigin);
  // A disabled inbox reports no id. Unless this mount disabled it, the panel cannot tell which inbox it was, so it
  // lists every personal endpoint aimed at an inbox of this site and lets the user clean up the dead ones.
  const retired = !inboxEnabled && inboxUrl === null;
  const matchKey = inboxUrl ?? (retired ? `any:${serviceOrigin}` : null);
  const reading = active && selfSubscribe && matchKey !== null;
  const [directory, setDirectory] = useState<{ readonly url: string; readonly value: Directory } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!reading || matchKey === null) return;
    const matches = inboxUrl === null ? (target: string | null) => targetsAnyInbox(target, serviceOrigin) : (target: string | null) => targetsInbox(target, inboxUrl);
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    void (async () => {
      try {
        await scope.ready(signal);
        const value = await loadDirectory(scope, matches, !retired, signal);
        if (!signal.aborted) { setDirectory({ url: matchKey, value }); setLoadError(null); }
      } catch (error) { if (!signal.aborted) setLoadError(error); }
    })();
    return () => controller.abort();
  }, [reading, inboxUrl, matchKey, retired, serviceOrigin, scope, revision]);
  // A confirmed create is adopted immediately so a slow or failed directory refresh cannot reopen the create branch
  // and produce a second independent endpoint.
  const [created, setCreated] = useState<{ readonly url: string; readonly endpointId: string; readonly endpoint: WebhookActiveEndpoint | null } | null>(null);
  const adopted = created?.url === matchKey ? created : null;
  const loaded = directory?.url === matchKey ? directory.value : null;
  const data = loaded === null || adopted?.endpoint == null || loaded.personal.some(item => item.id === adopted.endpointId) ? loaded : { ...loaded, personal: [...loaded.personal, adopted.endpoint] };
  const awaitingCreated = adopted !== null && !(data?.personal.some(item => item.id === adopted.endpointId) ?? false);

  const controller = useMemo(() => selfSubscribe && !scope.isInvalidated ? new WebhookIntentController({ serviceOrigin, owner: { kind: 'personal', id: scope.userId }, admission: webhookAdmission(scope), signal: scope.signal }) : null, [selfSubscribe, serviceOrigin, scope]);
  useEffect(() => () => controller?.dispose(), [controller]);
  const intent = useSyncExternalStore(controller?.subscribe ?? inertSubscribe, controller?.getSnapshot ?? (() => idle));
  const busy = intent.phase === 'preparing' || intent.phase === 'submitting' || intent.phase === 'unknown' || intent.reconciling;
  const [failure, setFailure] = useState<unknown>(null);
  // Both a direct submit and a manual reconciliation can confirm a create; either way the endpoint is adopted.
  const confirm = useCallback((state: WebhookIntentState) => {
    if (state.result?.operation.kind === 'endpoint.create' && matchKey !== null) {
      const endpoint = state.result.endpoint?.lifecycle === 'active' ? state.result.endpoint : null;
      setCreated({ url: matchKey, endpointId: state.result.operation.endpointId, endpoint });
    }
    setRevision(value => value + 1);
  }, [matchKey]);
  const submit = useCallback(async (input: WebhookIntentInput) => {
    if (controller === null) return false;
    setFailure(null);
    try {
      const state = await controller.submit(input);
      if (state.phase === 'rejected') { setFailure(state.error); return false; }
      if (state.phase === 'confirmed') { confirm(state); return true; }
      return false;
    } catch (error) { setFailure(error); return false; }
  }, [controller, confirm]);
  const reconcile = async () => { const state = await controller?.reconcile(); if (state?.phase === 'confirmed') confirm(state); };

  const primary = data?.personal.find(endpoint => endpoint.enabled) ?? data?.personal[0] ?? null;
  const [draft, setDraft] = useState<{ readonly projects: readonly string[]; readonly events: readonly WebhookEventType[] } | null>(null);
  // The event choices show the union over projects. Saving applies only the events the user added or removed to each
  // existing project, so per-project selections made on the Webhook page survive an unchanged save.
  const baseline = useMemo(() => ({ projects: primary?.subscriptions.map(item => item.projectId) ?? [], events: EVENT_TYPES.filter(event => primary?.subscriptions.some(item => item.eventTypes.includes(event))) }), [primary]);
  // An edit in progress survives background reloads; a confirmed save adopts the service's configuration again.
  const lastRevision = useRef(revision);
  useEffect(() => { if (lastRevision.current !== revision) { lastRevision.current = revision; setDraft(null); } }, [revision]);
  const selection = draft ?? baseline;
  const [invalid, setInvalid] = useState(false);
  const toggle = <K extends 'projects' | 'events',>(key: K, value: (typeof selection)[K][number], checked: boolean) => {
    setInvalid(false);
    setDraft(old => { const current = old ?? baseline, list = current[key] as readonly string[]; return { ...current, [key]: checked ? [...list, value] : list.filter(item => item !== value) }; });
  };
  const save = async () => {
    if (inboxUrl === null || primary === null && awaitingCreated) return;
    const added = selection.events.filter(event => !baseline.events.includes(event)), removed = baseline.events.filter(event => !selection.events.includes(event));
    const subscriptions = selection.projects.map(projectId => {
      const existing = primary?.subscriptions.find(item => item.projectId === projectId);
      const eventTypes = existing === undefined ? EVENT_TYPES.filter(event => selection.events.includes(event)) : [...existing.eventTypes.filter(event => !removed.includes(event)), ...added.filter(event => !existing.eventTypes.includes(event))];
      return { id: existing?.id ?? null, projectId, eventTypes };
    }).filter(item => item.eventTypes.length > 0);
    if (selection.events.length === 0 || subscriptions.length === 0) { setInvalid(true); return; }
    await submit(primary === null
      ? { kind: 'endpoint.create', body: { name: `${m.endpointName} · ${task.name}`.slice(0, 100), enabled: true, destination: { kind: 'http', adapterVersion: '1', configuration: { url: inboxUrl } }, subscriptions } }
      : { kind: 'endpoint.patch', endpointId: primary.id, ifVersion: primary.configVersion, destinationRevision: primary.destinationRevision, body: { subscriptions, ...(primary.enabled ? {} : { enabled: true }) } });
  };
  const pause = (endpoint: WebhookActiveEndpoint) => submit({ kind: 'endpoint.patch', endpointId: endpoint.id, ifVersion: endpoint.configVersion, destinationRevision: endpoint.destinationRevision, body: { enabled: false } });
  const remove = (endpoint: WebhookActiveEndpoint) => submit({ kind: 'endpoint.delete', endpointId: endpoint.id, ifVersion: endpoint.configVersion, body: {} });

  if (!selfSubscribe) return <section className="assistant-task-panel assistant-task-subscriptions" aria-labelledby={heading}><header><h3 id={heading}>{m.title}</h3></header><p className="notice">{m.local}</p></section>;
  if (matchKey === null) return null;
  // With no known inbox id, an empty list means there is nothing to clean up.
  if (retired && data !== null && data.personal.length + data.team.length === 0 && loadError === null) return null;
  const actionable = data?.personal.filter(endpoint => endpoint.capabilities.manage) ?? [];
  const projectNames = new Map<string, string>([...(primary?.subscriptions.map(item => [item.projectId, item.projectName ?? item.projectId] as const) ?? []), ...(data?.projects.map(project => [project.id, project.name] as const) ?? [])]);
  return <section className="assistant-task-panel assistant-task-subscriptions" aria-labelledby={heading}>
    <header><h3 id={heading}>{m.title}</h3></header>
    {inboxEnabled ? <p className="assistant-task-meta">{m.intro}</p> : null}
    {loadError !== null ? <div className="notice error" role="alert"><p>{m.loadError}</p><button className="button" type="button" onClick={() => setRevision(value => value + 1)}>{m.retry}</button></div> : null}
    {data === null ? loadError === null ? <p role="status">{m.loading}</p> : null : <>
      {data.team.length > 0 ? <p className="notice warning" role="alert">{m.teamWarning}</p> : null}
      {!inboxEnabled && data.personal.length > 0 ? <p className="notice warning" role="alert">{retired ? m.retiredWarning : m.disabledWarning}</p> : null}
      {inboxEnabled ? <form className="assistant-task-form assistant-task-subscription-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset><legend>{m.projects}</legend><div className="assistant-task-subscription-checks">
          {projectNames.size === 0 ? <span className="assistant-task-meta">{m.noProjects}</span> : [...projectNames].map(([id, name]) => <label key={id}><input type="checkbox" checked={selection.projects.includes(id)} onChange={event => toggle('projects', id, event.target.checked)} /><span>{name}</span></label>)}
        </div></fieldset>
        <fieldset><legend>{m.events}</legend><div className="assistant-task-subscription-checks">
          {EVENT_TYPES.map(event => <label key={event}><input type="checkbox" checked={selection.events.includes(event)} onChange={changed => toggle('events', event, changed.target.checked)} /><span>{wm.eventDescriptions[event]}</span></label>)}
        </div></fieldset>
        {invalid ? <p className="notice error" role="alert">{m.invalid}</p> : null}
        <div className="assistant-task-actions"><button className="button primary" type="submit" disabled={busy || (primary === null ? awaitingCreated : !primary.capabilities.manage)}>{primary === null ? m.create : m.save}</button></div>
      </form> : null}
      <h4>{m.linked}</h4>
      {data.personal.length + data.team.length === 0 ? <p className="assistant-task-meta">{m.none}</p> : <ul className="assistant-task-subscription-endpoints">
        {data.personal.map(endpoint => <li key={endpoint.id}>
          <span><strong>{endpoint.name}</strong><span className="assistant-task-meta">{m.personal} · {endpoint.enabled ? m.enabled : m.paused}</span></span>
          <span className="assistant-task-actions">
            <a className="button" href={webhookUrl({ owner: 'personal', teamId: null, endpointId: endpoint.id, tab: 'configuration' })}>{m.open}</a>
            {!inboxEnabled && actionable.includes(endpoint) ? <>
              {endpoint.enabled ? <button className="button" type="button" disabled={busy} onClick={() => void pause(endpoint)}>{m.pause}</button> : null}
              <button className="button danger" type="button" disabled={busy} onClick={() => void remove(endpoint)}>{m.delete}</button>
            </> : null}
          </span>
        </li>)}
        {data.team.map(({ team, endpoint }) => <li key={endpoint.id}>
          <span><strong>{endpoint.name}</strong><span className="assistant-task-meta">{m.team} · {team.name ?? team.id} · {endpoint.enabled ? m.enabled : m.paused}</span></span>
          <span className="assistant-task-actions"><a className="button" href={webhookUrl({ owner: 'team', teamId: team.id, endpointId: endpoint.id, tab: 'configuration' })}>{m.open}</a></span>
        </li>)}
      </ul>}
    </>}
    {intent.phase === 'unknown' && intent.prepared !== null ? <div className="notice warning" role="status"><p>{m.unknown}</p><code>{intent.prepared.operationId}</code><button className="button" type="button" disabled={intent.reconciling} onClick={() => void reconcile()}>{m.check}</button></div> : null}
    {failure !== null ? <p className="notice error" role="alert">{m.error}{failure instanceof ApiError && failure.code ? ` ${failure.code}` : ''}</p> : null}
  </section>;
}
