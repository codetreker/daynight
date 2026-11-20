import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
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
  personal: 'Personal', team: 'Team', enabled: 'Enabled', paused: 'Paused', open: 'Open',
  teamWarning: 'A Team endpoint targets this inbox. Team endpoints cannot pass the Daynight source check, so their deliveries are rejected for a missing token. Use the personal subscription here instead.',
  disabledWarning: 'The inbox is disabled. These personal endpoints target an assistant inbox on this site, which may belong to another task; deliveries to a disabled inbox are rejected and end. Open the ones that targeted this inbox to pause or delete them.',
  unknown: 'The result of the Webhook change is unknown. Check the original operation before making another change.', check: 'Check operation',
  error: 'The Webhook request failed.', conflict: 'This subscription changed elsewhere. The current configuration has been loaded; make your changes again.',
  loadError: 'Could not load Webhook subscriptions.', retry: 'Retry', loading: 'Loading…',
  endpointName: 'Assistant inbox',
  eventsFor: (project: string) => `Event types for ${project}`,
  maintenance: 'Webhook changes that add deliveries are temporarily unavailable. Removing event types remains available.',
  pausedNotice: 'This endpoint is paused, so no events are delivered to the inbox. Saving the subscription keeps it paused.', resume: 'Resume deliveries',
  unavailableProject: (id: string) => `Unavailable project (${id})`,
  confirmNotice: 'Deliveries for this project are suspended until you confirm its scope. New event types are not delivered before that; removing event types remains available.', confirmScope: 'Confirm scope',
  ineligible: 'Deliveries for this project are suspended. Removing event types remains available.',
};
const zh: typeof en = {
  title: 'Daynight 事件订阅',
  intro: '选择项目与事件类型。Daynight 通过一个属于你本人的 Webhook 端点，把匹配的事件投递到这个收件箱；端点目标是不含令牌的收件箱地址。',
  local: '当前部署未通过公网 HTTPS 提供服务。出站 Webhook 只投递到公网 HTTPS 目标，因此这个收件箱无法订阅本部署的事件；外部发送方仍可直接调用收件箱。',
  projects: '项目', events: '事件类型', noProjects: '没有可访问项目', save: '保存订阅', create: '创建订阅',
  invalid: '请至少选择一个项目，并为每个选中的项目至少选择一类事件。', linked: '指向此收件箱的端点', none: '还没有 Webhook 端点指向这个收件箱。',
  personal: '个人', team: '团队', enabled: '已启用', paused: '已暂停', open: '打开',
  teamWarning: '有团队端点指向这个收件箱。团队端点无法通过 Daynight 来源核验，其投递会因缺少令牌被拒绝。请改用这里的个人订阅。',
  disabledWarning: '收件箱已停用。以下个人端点指向本站的助手收件箱，其中可能有属于其他任务的收件箱；投向已停用收件箱的事件会被拒绝并结束。请打开原本指向这个收件箱的端点，再暂停或删除。',
  unknown: 'Webhook 修改结果未知。再次修改前，请核对原操作。', check: '核对操作',
  error: 'Webhook 请求失败。', conflict: '这个订阅已在别处被修改。已加载最新配置，请重新进行修改。',
  loadError: '无法读取 Webhook 订阅。', retry: '重试', loading: '正在加载…',
  endpointName: '助手收件箱',
  eventsFor: (project: string) => `${project} 的事件类型`,
  maintenance: '会新增投递的 Webhook 修改暂不可用；移除事件类型仍可进行。',
  pausedNotice: '这个端点已暂停，事件不会投递到收件箱。保存订阅不会恢复投递。', resume: '恢复投递',
  unavailableProject: (id: string) => `不可用的项目（${id}）`,
  confirmNotice: '这个项目的投递已暂停，需要先确认范围。确认前新增的事件类型不会投递；移除事件类型仍可进行。', confirmScope: '确认范围',
  ineligible: '这个项目的投递已暂停。移除事件类型仍可进行。',
};
const useMessages = () => useI18n().locale === 'zh-CN' ? zh : en;

const EVENT_TYPES: readonly WebhookEventType[] = ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted'];
const idle: WebhookIntentState = { phase: 'idle', prepared: null, result: null, error: null, reconciling: false, persistenceError: null };
const inertSubscribe = () => () => {};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Non-public IPv4 ranges of the IANA special-purpose registry that the outbound sender
// (packages/daynight-server/internal/utils/httpoutbound/address.go) rejects.
const NON_PUBLIC_V4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];
const publicV4 = (value: number) => !NON_PUBLIC_V4.some(([prefix, bits]) => (value >>> (32 - bits)) === (prefix >>> (32 - bits)));
const parseV6 = (host: string): number[] | null => {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => part === '' ? [] : part.split(':').map(group => /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN);
  const head = groups(halves[0]!), tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || halves.length === 1 && fill !== 0) return null;
  const all = [...head, ...Array<number>(fill).fill(0), ...tail];
  return all.some(Number.isNaN) ? null : all;
};
/** Mirrors the sender's public-address policy for IP literals; host names are resolved and checked only when delivering. */
const publicLiteral = (host: string): boolean => {
  const v4 = IPV4.exec(host);
  if (v4 !== null) return publicV4(v4.slice(1).reduce((value, part) => value * 256 + Number(part), 0));
  if (!host.includes(':')) return true;
  const groups = parseV6(host);
  if (groups === null) return false;
  // IPv4-mapped addresses are classified as their IPv4 address.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return publicV4((groups[6]! * 0x10000 + groups[7]!) >>> 0);
  const [first, second] = [groups[0]!, groups[1]!];
  // Only 2000::/3 is global unicast; within it the IETF protocol, documentation and 6to4 blocks are not public targets.
  return (first & 0xe000) === 0x2000 && !(first === 0x2001 && second < 0x0200) && !(first === 0x2001 && second === 0x0db8) && first !== 0x2002 && (first & 0xfff0) !== 0x3ff0;
};
/** Outbound delivery accepts only public HTTPS targets, so loopback, private-address and plain HTTP deployments cannot target their own inbox. */
export const canSelfSubscribe = (origin: string): boolean => {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return url.protocol === 'https:' && host !== 'localhost' && !host.endsWith('.localhost') && publicLiteral(host);
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
// Each project shows the union of its subscriptions' events. A project may hold several independent subscriptions; it
// appears once.
const selectionOf = (endpoint: WebhookActiveEndpoint | null): Selection => {
  const result: Record<string, WebhookEventType[]> = {};
  for (const item of endpoint?.subscriptions ?? []) result[item.projectId] = EVENT_TYPES.filter(event => result[item.projectId]?.includes(event) || item.eventTypes.includes(event));
  return result;
};
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

/**
 * Reads the accessible projects and the endpoints targeting the inbox. `editable` also reads the Webhook catalog, whose
 * expansion flag lets the panel explain a maintenance window before submitting, and the Team endpoints that cannot
 * deliver to a personal inbox.
 */
async function loadDirectory(scope: TaskCacheScope, matches: (target: string | null) => boolean, editable: boolean, signal: AbortSignal): Promise<Directory> {
  const admission = webhookAdmission(scope), personal: WebhookOwner = { kind: 'personal', id: scope.userId };
  const projects = await pages(cursor => listProjects({ limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }));
  const expansionAvailable = editable ? (await getWebhookCatalog(signal, admission)).service.configurationExpansionAvailable : true;
  const summaries = (await pages(cursor => listWebhooks(personal, { limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, admission))).filter(item => matches(item.destination.url));
  const details = await Promise.all(summaries.map(item => getWebhook(personal, item.id, signal, admission)));
  const teams = editable ? (await pages(cursor => listTeams(cursor, scope.userId, signal, scope.principalMismatch))).filter(team => team.kind === 'ordinary') : [];
  const team: TeamEndpoint[] = [];
  for (const entry of teams) {
    const owner: WebhookOwner = { kind: 'team', id: entry.id };
    // A Team endpoint the user cannot read is not something the user can act on; it does not block the personal subscription.
    const items = await pages(cursor => listWebhooks(owner, { limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, admission)).catch(error => { if (signal.aborted) throw error; return []; });
    team.push(...items.filter(item => matches(item.destination.url)).map(endpoint => ({ team: entry, endpoint })));
  }
  return { projects, personal: details.filter((item): item is WebhookActiveEndpoint => item.lifecycle === 'active' && matches(item.destination.url)), team, expansionAvailable };
}

/**
 * Personal outbound Webhook subscription for an assistant task inbox. The inbox and the endpoint are independent
 * resources: this panel only creates or edits the user's own endpoint, and disabling the inbox leaves endpoints in place.
 *
 * Consistency is the service's responsibility. An edit is submitted with the endpoint version it was made on, so the
 * service rejects it with `version_conflict` if the endpoint changed meanwhile; every write carries an operation ID
 * whose receipt makes a retry or an unknown outcome checkable; and the inbox accepts each Daynight event ID once, so
 * several endpoints targeting it do not duplicate inbound events. After every write, successful or not, the panel
 * reloads the directory and starts again from the service's configuration.
 */
export function AssistantTaskSubscriptions({ task, inboxId, inboxEnabled, active, serviceOrigin = globalThis.location?.origin ?? '' }: {
  readonly task: AssistantTask; readonly inboxId: string | null; readonly inboxEnabled: boolean; readonly active: boolean; readonly serviceOrigin?: string;
}) {
  const m = useMessages(), wm = useWebhookMessages(), scope = useTaskCacheScope(), heading = useId();
  const selfSubscribe = canSelfSubscribe(serviceOrigin), inboxUrl = inboxEnabled && inboxId !== null ? assistantTaskInboxUrl(inboxId, serviceOrigin) : null;
  // A disabled inbox reports no id, so the panel lists every personal endpoint aimed at an inbox of this site and lets
  // the user open the dead ones for cleanup.
  const matchKey = inboxUrl ?? (inboxEnabled ? null : `any:${serviceOrigin}`);
  const matches = useCallback((target: string | null) => inboxUrl === null ? targetsAnyInbox(target, serviceOrigin) : targetsInbox(target, inboxUrl), [inboxUrl, serviceOrigin]);
  const [directory, setDirectory] = useState<{ readonly key: string; readonly value: Directory } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null), [reload, setReload] = useState(0);
  // The user's selection while editing; null shows the loaded configuration. Every load discards it, so an edit is
  // always made on, and submitted with the version of, the endpoint currently shown.
  const [draft, setDraft] = useState<Selection | null>(null);
  useEffect(() => {
    if (!active || !selfSubscribe || matchKey === null) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    void (async () => {
      try {
        await scope.ready(signal);
        const value = await loadDirectory(scope, matches, inboxEnabled, signal);
        if (signal.aborted) return;
        setDirectory({ key: matchKey, value }); setDraft(null); setLoadError(null);
      } catch (error) { if (!signal.aborted) setLoadError(error); }
    })();
    return () => controller.abort();
  }, [active, selfSubscribe, matches, matchKey, inboxEnabled, scope, reload]);
  const data = directory?.key === matchKey ? directory.value : null;

  const controller = useMemo(() => selfSubscribe && !scope.isInvalidated ? new WebhookIntentController({ serviceOrigin, owner: { kind: 'personal', id: scope.userId }, admission: webhookAdmission(scope), signal: scope.signal }) : null, [selfSubscribe, serviceOrigin, scope]);
  useEffect(() => () => controller?.dispose(), [controller]);
  const intent = useSyncExternalStore(controller?.subscribe ?? inertSubscribe, controller?.getSnapshot ?? (() => idle));
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState<unknown>(null), [invalid, setInvalid] = useState(false);
  // Inputs are disabled while a request is pending so the submitted choices are the ones on screen.
  const locked = saving || intent.phase === 'preparing' || intent.phase === 'submitting' || intent.phase === 'unknown' || intent.reconciling;
  /** Submits one change, shows a rejection, and reloads the directory whatever the outcome. */
  const run = async (input: WebhookIntentInput) => {
    if (controller === null || locked) return;
    setFailure(null); setInvalid(false); setSaving(true);
    try {
      const state = await controller.submit(input);
      if (state.phase === 'rejected') setFailure(state.error);
    } catch (error) { setFailure(error); }
    finally { setSaving(false); setReload(value => value + 1); }
  };
  const reconcile = async () => { await controller?.reconcile(); setReload(value => value + 1); };

  const primary = data?.personal.find(endpoint => endpoint.enabled) ?? data?.personal[0] ?? null;
  const current = useMemo(() => selectionOf(primary), [primary]);
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
  const expansionAvailable = data?.expansionAvailable ?? true;
  const save = () => {
    if (inboxUrl === null || data === null) return;
    const chosen = Object.entries(selection);
    // Every checked project must keep at least one event type, so the submitted project list always equals the form's.
    if (chosen.length === 0 || chosen.some(([, events]) => events.length === 0)) { setInvalid(true); return; }
    // PATCH replaces the whole subscription list, so each existing subscription of a selected project is resubmitted under
    // its own id. An event removed from a project leaves every one of its subscriptions; an added event joins the
    // project's first subscription. A subscription left without events is dropped, and since the project keeps at least
    // one selected event, its first subscription then receives that event.
    const subscriptions = chosen.flatMap(([projectId, events]): WebhookSubscriptionInput[] => {
      const existing = primary?.subscriptions.filter(item => item.projectId === projectId) ?? [];
      if (existing.length === 0) return [{ id: null, projectId, eventTypes: events }];
      const before = current[projectId] ?? [], added = events.filter(event => !before.includes(event)), removed = before.filter(event => !events.includes(event));
      return existing.map((item, index) => ({ id: item.id, projectId, eventTypes: [...item.eventTypes.filter(event => !removed.includes(event)), ...(index === 0 ? added.filter(event => !item.eventTypes.includes(event)) : [])] }));
    }).filter(item => item.eventTypes.length > 0);
    // The service limits names to 100 code points; slicing code points never leaves a lone surrogate. A subscription
    // save omits `enabled`, so a paused endpoint stays paused.
    const input: WebhookIntentInput = primary === null
      ? { kind: 'endpoint.create', body: { name: [...`${m.endpointName} · ${task.name}`].slice(0, 100).join(''), enabled: true, destination: { kind: 'http', adapterVersion: '1', configuration: { url: inboxUrl } }, subscriptions } }
      : { kind: 'endpoint.patch', endpointId: primary.id, ifVersion: primary.configVersion, destinationRevision: primary.destinationRevision, body: { subscriptions } };
    // The service answers an expansion during maintenance with 503 before recording a receipt, which the intent
    // controller could only report as an unknown outcome; the catalog's flag is applied before submission instead.
    if (!expansionAvailable && webhookExpansion(input, primary)) { setFailure(new ApiError('server', 503, 'webhooks_unavailable')); return; }
    void run(input);
  };
  const patch = (endpoint: WebhookActiveEndpoint, body: { readonly enabled: true } | { readonly confirmProjectIds: readonly string[] }) =>
    void run({ kind: 'endpoint.patch', endpointId: endpoint.id, ifVersion: endpoint.configVersion, destinationRevision: endpoint.destinationRevision, body });
  // Resuming deliveries and confirming a project's scope add deliveries; they act on the endpoint as loaded and are
  // offered without unsaved edits, which their reload would discard.
  const expanding = locked || draft !== null || !expansionAvailable;

  if (!selfSubscribe) return <section className="assistant-task-panel assistant-task-subscriptions" aria-labelledby={heading}><header><h3 id={heading}>{m.title}</h3></header><p className="notice">{m.local}</p></section>;
  if (matchKey === null) return null;
  // A disabled inbox with no endpoint aimed at this site's inboxes has nothing to clean up.
  if (!inboxEnabled && data !== null && data.personal.length + data.team.length === 0 && loadError === null) return null;
  // A project the user can no longer access is still listed while the endpoint or the selection includes it, so it can be
  // removed; it is labelled by id rather than by a name the user may no longer read.
  const accessible = new Set(data?.projects.map(project => project.id) ?? []);
  const projectNames = new Map<string, string>([
    ...[...(primary?.subscriptions.map(item => item.projectId) ?? []), ...Object.keys(selection)].map(id => [id, m.unavailableProject(id)] as const),
    ...(data?.projects.map(project => [project.id, project.name] as const) ?? []),
  ]);
  // Event capture skips a subscription that is not eligible, so an event added to it is not delivered. Adding is blocked
  // for such a project until its scope is confirmed; removing events stays available.
  const eligibility = new Map((primary?.subscriptions ?? []).filter(item => item.eligibility !== 'eligible').map(item => [item.projectId, item.eligibility] as const));
  return <section className="assistant-task-panel assistant-task-subscriptions" aria-labelledby={heading}>
    <header><h3 id={heading}>{m.title}</h3></header>
    {inboxEnabled ? <p className="assistant-task-meta">{m.intro}</p> : null}
    {loadError !== null ? <div className="notice error" role="alert"><p>{m.loadError}</p><button className="button" type="button" onClick={() => setReload(value => value + 1)}>{m.retry}</button></div> : null}
    {data === null ? loadError === null ? <p role="status">{m.loading}</p> : null : <>
      {data.team.length > 0 ? <p className="notice warning" role="alert">{m.teamWarning}</p> : null}
      {!inboxEnabled ? <p className="notice warning" role="alert">{m.disabledWarning}</p> : null}
      {inboxEnabled && !data.expansionAvailable ? <p className="notice warning" role="status">{m.maintenance}</p> : null}
      {inboxEnabled && primary !== null && !primary.enabled ? <div className="notice warning" role="status"><p>{m.pausedNotice}</p>{primary.capabilities.manage ? <button className="button" type="button" disabled={expanding} onClick={() => patch(primary, { enabled: true })}>{m.resume}</button> : null}</div> : null}
      {inboxEnabled ? <form className="assistant-task-form assistant-task-subscription-form" onSubmit={event => { event.preventDefault(); save(); }}>
        <fieldset disabled={locked}><legend>{m.projects}</legend><div className="assistant-task-subscription-projects">
          {projectNames.size === 0 ? <span className="assistant-task-meta">{m.noProjects}</span> : [...projectNames].map(([id, name]) => {
            const events = selection[id], status = eligibility.get(id);
            return <div key={id} className="assistant-task-subscription-project">
              <label><input type="checkbox" checked={events !== undefined} onChange={event => toggleProject(id, event.target.checked)} /><span>{name}</span></label>
              {status === undefined ? null : <div className="notice warning" role="status"><p>{wm.eligibility[status]} · {status === 'confirmation_required' ? m.confirmNotice : m.ineligible}</p>
                {status === 'confirmation_required' && primary !== null && primary.capabilities.manage && accessible.has(id) ? <button className="button" type="button" disabled={expanding} onClick={() => patch(primary, { confirmProjectIds: [id] })}>{m.confirmScope}</button> : null}
              </div>}
              {events === undefined ? null : <div className="assistant-task-subscription-checks" role="group" aria-label={m.eventsFor(name)}>
                {EVENT_TYPES.map(event => <label key={event}><input type="checkbox" checked={events.includes(event)} disabled={status !== undefined && !events.includes(event)} onChange={changed => toggleEvent(id, event, changed.target.checked)} /><span>{wm.eventDescriptions[event]}</span></label>)}
              </div>}
            </div>;
          })}
        </div></fieldset>
        {invalid ? <p className="notice error" role="alert">{m.invalid}</p> : null}
        <div className="assistant-task-actions"><button className="button primary" type="submit" disabled={locked || (primary === null ? !data.expansionAvailable : !primary.capabilities.manage)}>{primary === null ? m.create : m.save}</button></div>
      </form> : null}
      <h4>{m.linked}</h4>
      {data.personal.length + data.team.length === 0 ? <p className="assistant-task-meta">{m.none}</p> : <ul className="assistant-task-subscription-endpoints">
        {data.personal.map(endpoint => <li key={endpoint.id}>
          <span><strong>{endpoint.name}</strong><span className="assistant-task-meta">{m.personal} · {endpoint.enabled ? m.enabled : m.paused}</span>{inboxEnabled ? null : <span className="assistant-task-meta">{endpoint.destination.displayUrl}</span>}</span>
          <span className="assistant-task-actions"><a className="button" href={webhookUrl({ owner: 'personal', teamId: null, endpointId: endpoint.id, tab: 'configuration' })}>{m.open}</a></span>
        </li>)}
        {data.team.map(({ team, endpoint }) => <li key={endpoint.id}>
          <span><strong>{endpoint.name}</strong><span className="assistant-task-meta">{m.team} · {team.name ?? team.id} · {endpoint.enabled ? m.enabled : m.paused}</span></span>
          <span className="assistant-task-actions"><a className="button" href={webhookUrl({ owner: 'team', teamId: team.id, endpointId: endpoint.id, tab: 'configuration' })}>{m.open}</a></span>
        </li>)}
      </ul>}
    </>}
    {intent.phase === 'unknown' && intent.prepared !== null ? <div className="notice warning" role="status"><p>{m.unknown}</p><code>{intent.prepared.operationId}</code><button className="button" type="button" disabled={intent.reconciling} onClick={() => void reconcile()}>{m.check}</button></div> : null}
    {failure !== null ? <p className="notice error" role="alert">{versionConflict(failure) ? m.conflict : <>{m.error}{failure instanceof ApiError && failure.code ? ` ${failure.code}` : ''}</>}</p> : null}
  </section>;
}
