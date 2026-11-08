import { useId, useState, type FormEvent } from "react";
import type { Project } from "../../api/types";
import type { WebhookActiveEndpoint, WebhookEventType, WebhookSubscriptionInput, WebhookSubscription } from "../../api/webhooks";
import type { WebhookIntentInput, WebhookIntentState } from "../webhook-intents/controller";
import { WebhookDialog } from "./WebhookDialog";
import { WebhookError } from "./WebhookError";
import { WebhookPendingNotice } from "./WebhookPendingNotice";
import { WebhookIcon } from "./WebhookIcon";
import { useWebhookMessages } from "./messages";

const events: readonly WebhookEventType[] = ["task.status_changed", "task.created", "task.deleted", "task.step_updated", "task.thread_posted", "task.paused"];
export const EventChecks = ({ value, onChange, canAdd = true }: { readonly value: readonly WebhookEventType[]; readonly onChange: (events: readonly WebhookEventType[]) => void; readonly canAdd?: boolean }) => {
  const m = useWebhookMessages();
  return <fieldset className="form-field"><legend className="field-title">{m.selectEvents}</legend><div className="event-checks">{events.map(event => <label className="check-row" key={event}><input type="checkbox" checked={value.includes(event)} disabled={!canAdd && !value.includes(event)} onChange={e => onChange(e.target.checked ? [...value, event] : value.filter(old => old !== event))}/><span className="check-main"><strong>{event}</strong><small>{m.eventDescriptions[event]}</small></span></label>)}</div></fieldset>;
};
const invalidUrl = (url: string) => { try { const value = new URL(url); return value.protocol !== "https:" || value.hostname === ""; } catch { return true; } };
export type WebhookFormActions = {
  readonly state: WebhookIntentState;
  readonly canSubmit: boolean;
  readonly canRead: boolean;
  readonly reconcile: () => void;
  readonly submit: (input: WebhookIntentInput) => Promise<WebhookIntentState>;
  readonly onClose: () => void;
  readonly opener: HTMLElement | null;
};
const isPending = (state: WebhookIntentState) => ["preparing", "submitting", "unknown"].includes(state.phase);
const errorFor = (state: WebhookIntentState) => state.phase === "rejected" || state.phase === "unknown" ? state.error : null;
export const WebhookConfigurationDialog = ({ endpoint, projects, projectLabels, actions, onReview }: {
  readonly endpoint: WebhookActiveEndpoint | null; readonly projects: readonly Project[] | null; readonly projectLabels: ReadonlyMap<string, string>; readonly actions: WebhookFormActions;
  readonly onReview: () => Promise<WebhookActiveEndpoint | null>;
}) => {
  const m = useWebhookMessages(), formId = useId(), [baseline, setBaseline] = useState(endpoint), [name, setName] = useState(endpoint?.name ?? ""), [url, setUrl] = useState(endpoint?.destination.url ?? ""), [selectedProjects, setSelectedProjects] = useState<readonly string[]>([]), [selectedEvents, setSelectedEvents] = useState<readonly WebhookEventType[]>([]), [validation, setValidation] = useState<string | null>(null), [reviewing, setReviewing] = useState(false), [localError, setLocalError] = useState<unknown>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!actions.canSubmit || isPending(actions.state)) return;
    if (name.trim() === "") { setValidation(m.invalidName); return; }
    if (invalidUrl(url)) { setValidation(m.invalidUrl); return; }
    if (baseline === null && selectedProjects.length > 0 && selectedEvents.length === 0) { setValidation(m.invalidEvents); return; }
    setValidation(null); setLocalError(null);
    try {
      if (baseline === null) await actions.submit({ kind: "endpoint.create", body: { name, enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url } }, subscriptions: selectedProjects.map(projectId => ({ id: null, projectId, eventTypes: selectedEvents })) } });
      else await actions.submit({ kind: "endpoint.patch", endpointId: baseline.id, ifVersion: baseline.configVersion, destinationRevision: baseline.destinationRevision, body: { ...(name === baseline.name ? {} : { name }), ...(url === baseline.destination.url ? {} : { destination: { kind: "http", adapterVersion: "1", configuration: { url } } }) } });
    } catch (error) { setLocalError(error); }
  };
  const unchanged = baseline !== null && name === baseline.name && url === baseline.destination.url;
  const review = async () => { setReviewing(true); try { const current = await onReview(); if (current !== null) setBaseline(current); } catch (error) { setLocalError(error); } finally { setReviewing(false); } };
  return <WebhookDialog title={baseline === null ? m.newTitle : m.editTitle} opener={actions.opener} onClose={actions.onClose} footer={<><button className="button" type="button" onClick={actions.onClose}>{m.cancel}</button><button className="button primary" type="submit" form={formId} disabled={!actions.canSubmit || isPending(actions.state) || unchanged || baseline === null && projects === null}>{baseline === null ? m.create : m.save}</button></>}>
    <form id={formId} onSubmit={event => { void submit(event); }}><WebhookPendingNotice state={actions.state} active={actions.canRead} onCheck={actions.reconcile}/>
      {validation !== null && <div className="inline-error" role="alert">{validation}</div>}{(localError ?? errorFor(actions.state)) !== null && <WebhookError error={localError ?? errorFor(actions.state)}/>}
      {actions.state.phase === "rejected" && baseline !== null && <button className="text-button" type="button" disabled={reviewing || !actions.canSubmit} onClick={() => { void review(); }}>{m.reviewCurrent}</button>}
      <div className="form-field"><label htmlFor="webhook-name">{m.name}</label><input id="webhook-name" className="input" name="name" value={name} placeholder={m.namePlaceholder} onChange={event => setName(event.target.value)} required autoComplete="off"/></div>
      <div className="form-field"><label htmlFor="webhook-url">{m.url}</label><input id="webhook-url" className="input" name="url" type="url" value={url} placeholder={m.urlPlaceholder} onChange={event => setUrl(event.target.value)} required autoComplete="off"/></div>
      <div className="form-field"><span className="field-title">{m.receiveType}</span><div className="selected-type"><WebhookIcon name="code" size={20}/><div><strong>{m.method}</strong><small>CloudEvents · Standard Webhooks</small></div></div></div>
      {baseline === null && <><div className="form-divider"/><fieldset className="form-field"><legend className="field-title">{m.selectProjects}</legend><div className="checkbox-list">{projects === null ? <span>{m.loading}</span> : projects.length === 0 ? <span className="hint">{m.noProjects}</span> : projects.map(project => <label className="check-row" key={project.id}><input type="checkbox" checked={selectedProjects.includes(project.id)} onChange={event => setSelectedProjects(event.target.checked ? [...selectedProjects, project.id] : selectedProjects.filter(id => id !== project.id))}/><span className="check-main"><strong>{project.name}</strong><small>{projectLabels.get(project.id)}</small></span></label>)}</div></fieldset><EventChecks value={selectedEvents} onChange={setSelectedEvents}/></>}
    </form>
  </WebhookDialog>;
};

export const WebhookSubscriptionDialog = ({ endpoint, subscription, projects, projectLabels, actions }: {
  readonly endpoint: WebhookActiveEndpoint; readonly subscription: WebhookSubscription | null; readonly projects: readonly Project[] | null; readonly projectLabels: ReadonlyMap<string, string>; readonly actions: WebhookFormActions;
}) => {
  const m = useWebhookMessages(), formId = useId(), [projectId, setProjectId] = useState(subscription?.projectId ?? ""), [selectedEvents, setSelectedEvents] = useState<readonly WebhookEventType[]>(subscription?.eventTypes ?? []), [validation, setValidation] = useState<string | null>(null), [localError, setLocalError] = useState<unknown>(null);
  const canExpand = subscription === null || subscription.eligibility === "eligible";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!actions.canSubmit || isPending(actions.state)) return;
    if (projectId === "" || selectedEvents.length === 0) { setValidation(m.invalidEvents); return; }
    const replacement: WebhookSubscriptionInput = { id: subscription !== null && subscription.projectId === projectId ? subscription.id : null, projectId, eventTypes: selectedEvents };
    const subscriptions = subscription === null ? [...endpoint.subscriptions, replacement] : endpoint.subscriptions.map(old => old.id === subscription.id ? replacement : old);
    setValidation(null); setLocalError(null);
    try { await actions.submit({ kind: "endpoint.patch", endpointId: endpoint.id, ifVersion: endpoint.configVersion, destinationRevision: endpoint.destinationRevision, body: { subscriptions: subscriptions.map(({ id, projectId, eventTypes }) => ({ id, projectId, eventTypes })) } }); } catch (error) { setLocalError(error); }
  };
  const unavailableSelected = projectId !== "" && !projects?.some(project => project.id === projectId);
  return <WebhookDialog title={subscription === null ? m.addSub : m.editSub} opener={actions.opener} onClose={actions.onClose} footer={<><button className="button" type="button" onClick={actions.onClose}>{m.cancel}</button><button className="button primary" type="submit" form={formId} disabled={!actions.canSubmit || isPending(actions.state) || projects === null && subscription === null}>{m.save}</button></>}>
    <form id={formId} onSubmit={event => { void submit(event); }}><WebhookPendingNotice state={actions.state} active={actions.canRead} onCheck={actions.reconcile}/>{validation !== null && <div className="inline-error" role="alert">{validation}</div>}{(localError ?? errorFor(actions.state)) !== null && <WebhookError error={localError ?? errorFor(actions.state)}/>}
      <div className="form-field"><label htmlFor="webhook-subscription-project">{m.project}</label><select id="webhook-subscription-project" className="input" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={!canExpand}><option value="">{m.selectProjects}</option>{unavailableSelected && <option value={projectId}>{projectId}</option>}{projects?.map(project => <option value={project.id} key={project.id}>{project.name} · {projectLabels.get(project.id)}</option>)}</select></div>
      <EventChecks value={selectedEvents} onChange={setSelectedEvents} canAdd={canExpand}/>
    </form>
  </WebhookDialog>;
};
