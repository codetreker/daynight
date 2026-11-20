import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, listProjects } from '../../api/client';
import { assistantTaskInboxUrl, type AssistantTask } from '../../api/assistant-tasks';
import { listTeams, type Team } from '../../api/teams';
import type { Project } from '../../api/types';
import { getWebhook, getWebhookCatalog, listWebhooks, type WebhookActiveEndpoint, type WebhookAdmission, type WebhookEndpointSummary, type WebhookEventType, type WebhookOwner, type WebhookSubscriptionInput } from '../../api/webhooks';
import { webhookUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { WebhookIntentController, type WebhookIntentInput, type WebhookIntentState } from '../webhook-intents/controller';
import { webhookExpansion } from '../webhooks/admission';
import { useWebhookMessages } from '../webhooks/messages';

const en = {
  title: 'Daynight event subscription',
  intro: 'Choose projects and event types. Daynight delivers matching events to this inbox through a personal Webhook endpoint whose target is the token-free inbox URL.',
  local: 'This deployment is not served over public HTTPS. Outbound Webhooks only deliver to public HTTPS targets, so this inbox cannot subscribe to events from this deployment. External senders can still call the inbox directly.',
  projects: 'Projects', events: 'Event types', noProjects: 'No accessible projects', save: 'Save subscription', create: 'Create subscription',
  invalid: 'Select at least one project and at least one event type for each selected project.', linked: 'Endpoints targeting this inbox', none: 'No Webhook endpoint targets this inbox yet.',
  personal: 'Personal', team: 'Team', enabled: 'Enabled', paused: 'Paused', open: 'Open', pause: 'Pause', delete: 'Delete',
  teamWarning: 'A Team endpoint targets this inbox. Team endpoints cannot pass the Daynight source check, so their deliveries are rejected for a missing token. Use the personal subscription here instead.',
  disabledWarning: 'The inbox is disabled. Deliveries to these endpoints are rejected and end. Pause or delete the endpoints that still target it.',
  retiredWarning: 'The inbox is disabled. These personal endpoints target an assistant inbox on this site, which may belong to another task; deliveries to a disabled inbox are rejected and end. Open the ones that targeted this inbox to pause or delete them.',
  unknown: 'The result of the Webhook change is unknown. Check the original operation before making another change.', check: 'Check operation',
  error: 'The Webhook request failed.', loadError: 'Could not load Webhook subscriptions.', retry: 'Retry', loading: 'Loading…',
  endpointName: 'Assistant inbox',
  stale: 'This subscription changed elsewhere after you started editing. Discard your edits to load the current configuration before saving.', discard: 'Discard edits',
  eventsFor: (project: string) => `Event types for ${project}`,
  duplicate: 'Several personal endpoints target this inbox, so each matching event is delivered once per endpoint. Open the extra endpoints and delete them.',
  maintenance: 'Webhook changes that add deliveries are temporarily unavailable. Removing event types, pausing and deleting endpoints remain available.',
};
const zh: typeof en = {
  title: 'Daynight 事件订阅',
  intro: '选择项目与事件类型。Daynight 通过一个属于你本人的 Webhook 端点，把匹配的事件投递到这个收件箱；端点目标是不含令牌的收件箱地址。',
  local: '当前部署未通过公网 HTTPS 提供服务。出站 Webhook 只投递到公网 HTTPS 目标，因此这个收件箱无法订阅本部署的事件；外部发送方仍可直接调用收件箱。',
  projects: '项目', events: '事件类型', noProjects: '没有可访问项目', save: '保存订阅', create: '创建订阅',
  invalid: '请至少选择一个项目，并为每个选中的项目至少选择一类事件。', linked: '指向此收件箱的端点', none: '还没有 Webhook 端点指向这个收件箱。',
  personal: '个人', team: '团队', enabled: '已启用', paused: '已暂停', open: '打开', pause: '暂停', delete: '删除',
  teamWarning: '有团队端点指向这个收件箱。团队端点无法通过 Daynight 来源核验，其投递会因缺少令牌被拒绝。请改用这里的个人订阅。',
  disabledWarning: '收件箱已停用，投向这些端点的事件会被拒绝并结束。请暂停或删除仍指向它的端点。',
  retiredWarning: '收件箱已停用。以下个人端点指向本站的助手收件箱，其中可能有属于其他任务的收件箱；投向已停用收件箱的事件会被拒绝并结束。请打开原本指向这个收件箱的端点，再暂停或删除。',
  unknown: 'Webhook 修改结果未知。再次修改前，请核对原操作。', check: '核对操作',
  error: 'Webhook 请求失败。', loadError: '无法读取 Webhook 订阅。', retry: '重试', loading: '正在加载…',
  endpointName: '助手收件箱',
  stale: '开始编辑后，这个订阅已在别处被修改。请先放弃当前修改并加载最新配置，再保存。', discard: '放弃修改',
  eventsFor: (project: string) => `${project} 的事件类型`,
  duplicate: '有多个个人端点指向这个收件箱，每个匹配事件会按端点各投递一次。请打开多余的端点并删除。',
  maintenance: '会新增投递的 Webhook 修改暂不可用；移除事件类型、暂停和删除端点仍可进行。',
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

/** The event types chosen for each selected project, keyed by project id. An unselected project has no key. */
type Selection = Readonly<Record<string, readonly WebhookEventType[]>>;
/** An edit is bound to the endpoint state it started from; `base` is null when the edit creates the endpoint. */
type Draft = { readonly base: WebhookActiveEndpoint | null; readonly projects: Selection };
// Each project shows the union of its subscriptions' events. A project may hold several independent subscriptions; it
// appears once.
const selectionOf = (endpoint: WebhookActiveEndpoint | null): Selection => {
  const result: Record<string, WebhookEventType[]> = {};
  for (const item of endpoint?.subscriptions ?? []) result[item.projectId] = EVENT_TYPES.filter(event => result[item.projectId]?.includes(event) || item.eventTypes.includes(event));
  return result;
};
const sameEndpointState = (left: WebhookActiveEndpoint | null, right: WebhookActiveEndpoint | null) => left === null || right === null
  ? left === right
  : left.id === right.id && left.configVersion === right.configVersion && left.destinationRevision === right.destinationRevision;
const versionConflict = (error: unknown) => error instanceof ApiError && error.kind === 'server' && error.code === 'version_conflict';

type TeamEndpoint = { readonly team: Team; readonly endpoint: WebhookEndpointSummary };
type Directory = { readonly projects: readonly Project[]; readonly personal: readonly WebhookActiveEndpoint[]; readonly team: readonly TeamEndpoint[]; readonly expansionAvailable: boolean };

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

const linkedSummaries = async (scope: TaskCacheScope, matches: (target: string | null) => boolean, signal: AbortSignal) =>
  (await pages(cursor => listWebhooks({ kind: 'personal', id: scope.userId }, { limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, webhookAdmission(scope)))).filter(item => matches(item.destination.url));

const endpointGone = (error: unknown) => error instanceof ApiError && error.kind === 'server' && (error.status === 404 || error.status === 410);

/**
 * `pendingId` names a confirmed create whose destination is not yet known. It is read directly so the directory states
 * authoritatively whether that endpoint targets this inbox, independent of list ordering or pagination. `editable` reads
 * the Webhook catalog, whose expansion gate decides whether a create or an added event may be submitted; cleanup of a
 * disabled inbox only removes deliveries and does not need it.
 */
async function loadDirectory(scope: TaskCacheScope, matches: (target: string | null) => boolean, editable: boolean, pendingId: string | null, signal: AbortSignal): Promise<Directory> {
  const admission = webhookAdmission(scope), personal: WebhookOwner = { kind: 'personal', id: scope.userId };
  const projects = await pages(cursor => listProjects({ limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }));
  const expansionAvailable = editable ? (await getWebhookCatalog(signal, admission)).service.configurationExpansionAvailable : true;
  const linked = await Promise.all((await linkedSummaries(scope, matches, signal)).map(item => getWebhook(personal, item.id, signal, admission)));
  if (pendingId !== null && !linked.some(item => item.id === pendingId)) {
    const pending = await getWebhook(personal, pendingId, signal, admission).catch(error => { if (endpointGone(error)) return null; throw error; });
    if (pending?.lifecycle === 'active' && matches(pending.destination.url)) linked.push(pending);
  }
  const teams = editable ? (await pages(cursor => listTeams(cursor, scope.userId, signal, scope.principalMismatch))).filter(team => team.kind === 'ordinary') : [];
  const team: TeamEndpoint[] = [];
  for (const entry of teams) {
    const owner: WebhookOwner = { kind: 'team', id: entry.id };
    // A Team endpoint the user cannot read is not something the user can act on; it does not block the personal subscription.
    const items = await pages(cursor => listWebhooks(owner, { limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, admission)).catch(error => { if (signal.aborted) throw error; return []; });
    team.push(...items.filter(item => matches(item.destination.url)).map(endpoint => ({ team: entry, endpoint })));
  }
  // A list summary and its detail are separate reads, so another tab may retarget the endpoint between them. Only a
  // detail that still targets this inbox may back actions; otherwise its fresh configVersion would let a save or
  // cleanup here modify another inbox's subscription without an optimistic-concurrency conflict.
  return { projects, personal: linked.filter((item): item is WebhookActiveEndpoint => item.lifecycle === 'active' && matches(item.destination.url)), team, expansionAvailable };
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
  // `revision` reloads and adopts the service configuration again; `refresh` reloads while keeping an edit in progress.
  const [loadError, setLoadError] = useState<unknown>(null), [revision, setRevision] = useState(0), [refresh, setRefresh] = useState(0);
  // A confirmed create is adopted immediately so a slow or failed directory refresh cannot reopen the create branch
  // and produce a second independent endpoint. A receipt-only confirmation does not show the destination: the
  // controller restores a pending operation per user rather than per inbox, so it may belong to another inbox. Such an
  // adoption stays unverified until a directory load reads the endpoint and either keeps it or releases it. A returned view
  // is verified the same way: once a successful load reads the endpoint directly and finds it deleted or retargeted
  // elsewhere, the adoption ends and the panel offers Create again.
  const [created, setCreated] = useState<{ readonly url: string; readonly endpointId: string; readonly endpoint: WebhookActiveEndpoint | null } | null>(null);
  const createdRef = useRef(created);
  createdRef.current = created;
  const matches = useCallback((target: string | null) => inboxUrl === null ? targetsAnyInbox(target, serviceOrigin) : targetsInbox(target, inboxUrl), [inboxUrl, serviceOrigin]);
  useEffect(() => {
    if (!reading || matchKey === null) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    const pending = createdRef.current?.url === matchKey ? createdRef.current : null;
    void (async () => {
      try {
        await scope.ready(signal);
        const value = await loadDirectory(scope, matches, !retired, pending?.endpointId ?? null, signal);
        if (signal.aborted) return;
        setDirectory({ url: matchKey, value }); setLoadError(null);
        if (pending !== null && !value.personal.some(item => item.id === pending.endpointId)) setCreated(old => old?.url === pending.url && old.endpointId === pending.endpointId ? null : old);
      } catch (error) { if (!signal.aborted) setLoadError(error); }
    })();
    return () => controller.abort();
  }, [reading, matches, matchKey, retired, scope, revision, refresh]);
  const adopted = created?.url === matchKey ? created : null;
  const loaded = directory?.url === matchKey ? directory.value : null;
  const data = loaded === null || adopted?.endpoint == null || loaded.personal.some(item => item.id === adopted.endpointId) ? loaded : { ...loaded, personal: [...loaded.personal, adopted.endpoint] };
  const awaitingCreated = adopted !== null && !(data?.personal.some(item => item.id === adopted.endpointId) ?? false);

  const controller = useMemo(() => selfSubscribe && !scope.isInvalidated ? new WebhookIntentController({ serviceOrigin, owner: { kind: 'personal', id: scope.userId }, admission: webhookAdmission(scope), signal: scope.signal }) : null, [selfSubscribe, serviceOrigin, scope]);
  useEffect(() => () => controller?.dispose(), [controller]);
  const intent = useSyncExternalStore(controller?.subscribe ?? inertSubscribe, controller?.getSnapshot ?? (() => idle));
  const busy = intent.phase === 'preparing' || intent.phase === 'submitting' || intent.phase === 'unknown' || intent.reconciling;
  const [failure, setFailure] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Set when the service rejected this draft's base version; the draft is kept but cannot be submitted again.
  const [conflicted, setConflicted] = useState(false);
  // Both a direct submit and a manual reconciliation can confirm a create; either way the endpoint is adopted.
  const confirm = useCallback((state: WebhookIntentState) => {
    if (state.result?.operation.kind === 'endpoint.create' && matchKey !== null && inboxUrl !== null) {
      const view = state.result.endpoint;
      // A returned view proves the destination; an endpoint aimed elsewhere or already deleted is not adopted.
      if (view === undefined) setCreated({ url: matchKey, endpointId: state.result.operation.endpointId, endpoint: null });
      else if (view.lifecycle === 'active' && targetsInbox(view.destination.url, inboxUrl)) setCreated({ url: matchKey, endpointId: view.id, endpoint: view });
    }
    // A confirmed change returns the endpoint's new state. Showing it at once keeps an edit started before the refresh
    // completes bound to the version this panel just wrote, instead of to the version it replaced.
    const view = state.result?.operation.kind === 'endpoint.create' ? undefined : state.result?.endpoint;
    if (view !== undefined) {
      const fresh = (item: WebhookActiveEndpoint): WebhookActiveEndpoint | null => item.id !== view.id ? item : view.lifecycle === 'active' && matches(view.destination.url) ? view : null;
      setDirectory(old => old === null ? old : { ...old, value: { ...old.value, personal: old.value.personal.flatMap(item => fresh(item) ?? []) } });
      setCreated(old => old?.endpoint == null || old.endpointId !== view.id ? old : { ...old, endpoint: fresh(old.endpoint) });
    }
    setDraft(null); setConflicted(false); setRevision(value => value + 1);
  }, [matchKey, inboxUrl, matches]);
  /** Returns the rejection error, or null when the change was confirmed or its outcome is unknown. */
  const submit = useCallback(async (input: WebhookIntentInput): Promise<unknown> => {
    if (controller === null) return null;
    setFailure(null);
    try {
      const state = await controller.submit(input);
      if (state.phase === 'rejected') { setFailure(state.error); return state.error; }
      if (state.phase === 'confirmed') confirm(state);
      return null;
    } catch (error) { setFailure(error); return error; }
  }, [controller, confirm]);
  const reconcile = async () => { const state = await controller?.reconcile(); if (state?.phase === 'confirmed') confirm(state); };

  const primary = data?.personal.find(endpoint => endpoint.enabled) ?? data?.personal[0] ?? null;
  // Saving applies only the events the user added or removed to each existing project, so selections made on the Webhook
  // page survive an unchanged save, and every subscription of a project is kept by its own id.
  const current = useMemo(() => selectionOf(primary), [primary]);
  // An edit in progress survives background reloads; a confirmed save or an explicit retry adopts the service's
  // configuration again.
  const lastRevision = useRef(revision);
  useEffect(() => { if (lastRevision.current !== revision) { lastRevision.current = revision; setDraft(null); setConflicted(false); } }, [revision]);
  // PATCH replaces the whole subscription list under the CAS version it names. A reload that advances the endpoint must
  // not carry an older draft to the newer version, which would silently drop subscriptions added elsewhere; nor may a
  // create draft proceed once an endpoint already targets this inbox. The draft keeps its starting state, and a
  // changed endpoint, or a version conflict the service reported for it, blocks saving until the user discards the edit.
  const editing = draft === null ? primary : draft.base;
  const baseline = useMemo(() => draft === null ? current : selectionOf(draft.base), [draft, current]);
  const stale = draft !== null && (conflicted || !sameEndpointState(draft.base, primary));
  const selection: Selection = draft?.projects ?? current;
  const [invalid, setInvalid] = useState(false);
  const edit = (change: (projects: Selection) => Selection) => {
    setInvalid(false);
    setDraft(old => { const next = old ?? { base: primary, projects: current }; return { ...next, projects: change(next.projects) }; });
  };
  // A project checked again starts from the events it had before the edit, so unchecking by mistake loses nothing.
  const toggleProject = (projectId: string, checked: boolean) => edit(projects => {
    const rest = Object.fromEntries(Object.entries(projects).filter(([id]) => id !== projectId));
    return checked ? { ...rest, [projectId]: baseline[projectId] ?? [] } : rest;
  });
  const toggleEvent = (projectId: string, event: WebhookEventType, checked: boolean) => edit(projects => {
    const events = projects[projectId] ?? [];
    return { ...projects, [projectId]: checked ? EVENT_TYPES.filter(item => item === event || events.includes(item)) : events.filter(item => item !== event) };
  });
  const discard = () => { setInvalid(false); setDraft(null); setConflicted(false); setRefresh(value => value + 1); };
  const holdConflict = (held: Draft) => { setFailure(null); setDraft(held); setConflicted(true); setRefresh(value => value + 1); };
  const expansionAvailable = data?.expansionAvailable ?? true;
  const save = async () => {
    if (inboxUrl === null || stale || editing === null && awaitingCreated) return;
    const held: Draft = draft ?? { base: editing, projects: selection };
    const chosen = Object.entries(selection);
    // Every checked project must keep at least one event type, so the submitted project list always equals the form's.
    if (chosen.length === 0 || chosen.some(([, events]) => events.length === 0)) { setInvalid(true); return; }
    // PATCH replaces the whole subscription list, so each existing subscription of a selected project is resubmitted under
    // its own id. An event removed from a project leaves every one of its subscriptions; an added event joins the
    // project's first subscription. A subscription left without events is dropped, and since the project keeps at least
    // one selected event, its first subscription then receives that event.
    const subscriptions = chosen.flatMap(([projectId, events]): WebhookSubscriptionInput[] => {
      const existing = editing?.subscriptions.filter(item => item.projectId === projectId) ?? [];
      if (existing.length === 0) return [{ id: null, projectId, eventTypes: events }];
      const before = baseline[projectId] ?? [], added = events.filter(event => !before.includes(event)), removed = before.filter(event => !events.includes(event));
      return existing.map((item, index) => ({ id: item.id, projectId, eventTypes: [...item.eventTypes.filter(event => !removed.includes(event)), ...(index === 0 ? added.filter(event => !item.eventTypes.includes(event)) : [])] }));
    }).filter(item => item.eventTypes.length > 0);
    const input: WebhookIntentInput = editing === null
      ? { kind: 'endpoint.create', body: { name: `${m.endpointName} · ${task.name}`.slice(0, 100), enabled: true, destination: { kind: 'http', adapterVersion: '1', configuration: { url: inboxUrl } }, subscriptions } }
      : { kind: 'endpoint.patch', endpointId: editing.id, ifVersion: editing.configVersion, destinationRevision: editing.destinationRevision, body: { subscriptions, ...(editing.enabled ? {} : { enabled: true }) } };
    // The service answers an expansion during maintenance with 503 before recording a receipt, which would leave the
    // intent unknown and block later writes; the catalog gate is applied before submission instead.
    if (!expansionAvailable && webhookExpansion(input, editing)) return;
    if (editing === null) {
      // Webhook creation has no create-if-absent precondition, so a second tab could create a parallel endpoint. Reading
      // the targets again just before submission turns a create already made elsewhere into the stale-draft conflict;
      // the remaining race is surfaced by the duplicate-endpoint warning.
      try {
        if ((await linkedSummaries(scope, matches, scope.signal)).length > 0) { holdConflict(held); return; }
      } catch (error) { setFailure(error); return; }
    }
    if (versionConflict(await submit(input))) holdConflict(held);
  };
  const reloadOnConflict = async (input: WebhookIntentInput) => { if (versionConflict(await submit(input))) setRefresh(value => value + 1); };
  const pause = (endpoint: WebhookActiveEndpoint) => reloadOnConflict({ kind: 'endpoint.patch', endpointId: endpoint.id, ifVersion: endpoint.configVersion, destinationRevision: endpoint.destinationRevision, body: { enabled: false } });
  const remove = (endpoint: WebhookActiveEndpoint) => reloadOnConflict({ kind: 'endpoint.delete', endpointId: endpoint.id, ifVersion: endpoint.configVersion, body: {} });

  if (!selfSubscribe) return <section className="assistant-task-panel assistant-task-subscriptions" aria-labelledby={heading}><header><h3 id={heading}>{m.title}</h3></header><p className="notice">{m.local}</p></section>;
  if (matchKey === null) return null;
  // With no known inbox id, an empty list means there is nothing to clean up.
  if (retired && data !== null && data.personal.length + data.team.length === 0 && loadError === null) return null;
  // With an unknown inbox id the list may include endpoints of other tasks' inboxes, which can share a name and status.
  // Pause and delete act only on endpoints verified to target this inbox; the others are opened on their configuration
  // page, which shows the full destination.
  const actionable = retired ? [] : data?.personal.filter(endpoint => endpoint.capabilities.manage) ?? [];
  const projectNames = new Map<string, string>([...(primary?.subscriptions.map(item => [item.projectId, item.projectName ?? item.projectId] as const) ?? []), ...(data?.projects.map(project => [project.id, project.name] as const) ?? [])]);
  return <section className="assistant-task-panel assistant-task-subscriptions" aria-labelledby={heading}>
    <header><h3 id={heading}>{m.title}</h3></header>
    {inboxEnabled ? <p className="assistant-task-meta">{m.intro}</p> : null}
    {loadError !== null ? <div className="notice error" role="alert"><p>{m.loadError}</p><button className="button" type="button" onClick={() => setRevision(value => value + 1)}>{m.retry}</button></div> : null}
    {data === null ? loadError === null ? <p role="status">{m.loading}</p> : null : <>
      {data.team.length > 0 ? <p className="notice warning" role="alert">{m.teamWarning}</p> : null}
      {!inboxEnabled && data.personal.length > 0 ? <p className="notice warning" role="alert">{retired ? m.retiredWarning : m.disabledWarning}</p> : null}
      {inboxEnabled && data.personal.length > 1 ? <p className="notice warning" role="alert">{m.duplicate}</p> : null}
      {inboxEnabled && !data.expansionAvailable ? <p className="notice warning" role="status">{m.maintenance}</p> : null}
      {inboxEnabled ? <form className="assistant-task-form assistant-task-subscription-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset><legend>{m.projects}</legend><div className="assistant-task-subscription-projects">
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
        {stale ? <div className="notice warning" role="alert"><p>{m.stale}</p><button className="button" type="button" onClick={discard}>{m.discard}</button></div> : null}
        <div className="assistant-task-actions"><button className="button primary" type="submit" disabled={busy || stale || (editing === null ? awaitingCreated || !data.expansionAvailable : !editing.capabilities.manage)}>{editing === null ? m.create : m.save}</button></div>
      </form> : null}
      <h4>{m.linked}</h4>
      {data.personal.length + data.team.length === 0 ? <p className="assistant-task-meta">{m.none}</p> : <ul className="assistant-task-subscription-endpoints">
        {data.personal.map(endpoint => <li key={endpoint.id}>
          <span><strong>{endpoint.name}</strong><span className="assistant-task-meta">{m.personal} · {endpoint.enabled ? m.enabled : m.paused}</span>{retired ? <span className="assistant-task-meta">{endpoint.destination.displayUrl}</span> : null}</span>
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
