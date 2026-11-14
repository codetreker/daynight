import { NativeSelect } from "../../ui/native-select/NativeSelect";
import { useId, useState, type FormEvent } from "react";
import type { Project } from "../../api/types";
import type { WebhookActiveEndpoint, WebhookEventType, WebhookSubscriptionInput, WebhookSubscription } from "../../api/webhooks";
import type { WebhookIntentInput, WebhookIntentState } from "../webhook-intents/controller";
import { WebhookDialog } from "./WebhookDialog";
import { WebhookError } from "./WebhookError";
import { webhookExpansion } from "./admission";
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
  readonly expansionAvailable: boolean;
  readonly canRead: boolean;
  readonly reconcile: () => void;
  readonly submit: (input: WebhookIntentInput) => Promise<WebhookIntentState>;
  readonly onClose: () => void;
  readonly onDraftChange: () => void;
  readonly opener: HTMLElement | null;
};
const isPending = (state: WebhookIntentState) => ["preparing", "submitting", "unknown"].includes(state.phase) || state.reconciling;
const errorFor = (state: WebhookIntentState) => state.phase === "rejected" || state.phase === "unknown" ? state.error : null;
type ConfigurationField = "name" | "url";
type ConfigurationDraft = {
  readonly baseline: WebhookActiveEndpoint | null;
  readonly name: string;
  readonly url: string;
  readonly dirty: Readonly<Record<ConfigurationField, boolean>>;
  readonly conflicts: Readonly<Record<ConfigurationField, boolean>>;
};
const observedField = (endpoint: WebhookActiveEndpoint | null, field: ConfigurationField): string => field === "name" ? endpoint?.name ?? "" : endpoint?.destination.url ?? "";
const initialConfigurationDraft = (endpoint: WebhookActiveEndpoint | null): ConfigurationDraft => ({ baseline: endpoint, name: observedField(endpoint, "name"), url: observedField(endpoint, "url"), dirty: { name: false, url: false }, conflicts: { name: false, url: false } });
const reviewConfigurationDraft = (draft: ConfigurationDraft, current: WebhookActiveEndpoint): ConfigurationDraft => {
  const next: ConfigurationDraft = { ...draft, baseline: current, dirty: { ...draft.dirty }, conflicts: { ...draft.conflicts } };
  const fields = ["name", "url"] as const;
  return fields.reduce<ConfigurationDraft>((next, field) => {
    const value = draft.dirty[field] ? draft[field] : observedField(current, field);
    const dirty = value !== observedField(current, field);
    return { ...next, [field]: value, dirty: { ...next.dirty, [field]: dirty }, conflicts: { ...next.conflicts, [field]: dirty && (draft.conflicts[field] || observedField(draft.baseline, field) !== observedField(current, field)) } };
  }, next);
};

export const WebhookConfigurationDialog = ({ endpoint, projects, projectLabels, actions, onReview }: {
  readonly endpoint: WebhookActiveEndpoint | null; readonly projects: readonly Project[] | null; readonly projectLabels: ReadonlyMap<string, string>; readonly actions: WebhookFormActions;
  readonly onReview: () => Promise<WebhookActiveEndpoint | null>;
}) => {
  const m = useWebhookMessages(), formId = useId(), [draft, setDraft] = useState(() => initialConfigurationDraft(endpoint));
  const [selectedProjects, setSelectedProjects] = useState<readonly string[]>([]), [selectedEvents, setSelectedEvents] = useState<readonly WebhookEventType[]>([]), [validation, setValidation] = useState<string | null>(null), [reviewing, setReviewing] = useState(false), [localError, setLocalError] = useState<unknown>(null);
  const changeField = (field: ConfigurationField, value: string) => setDraft(old => ({ ...old, [field]: value, dirty: { ...old.dirty, [field]: value !== observedField(old.baseline, field) }, conflicts: { ...old.conflicts, [field]: false } }));
  const resolveField = (field: ConfigurationField, keepEdit: boolean) => { actions.onDraftChange(); setDraft(old => ({ ...old, [field]: keepEdit ? old[field] : observedField(old.baseline, field), dirty: { ...old.dirty, [field]: keepEdit && old[field] !== observedField(old.baseline, field) }, conflicts: { ...old.conflicts, [field]: false } })); };
  const conflicts = draft.conflicts.name || draft.conflicts.url;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!actions.canSubmit || isPending(actions.state) || conflicts || !actions.expansionAvailable && (draft.baseline === null || draft.dirty.url)) return;
    if ((draft.baseline === null || draft.dirty.name) && draft.name.trim() === "") { setValidation(m.invalidName); return; }
    if ((draft.baseline === null || draft.dirty.url) && invalidUrl(draft.url)) { setValidation(m.invalidUrl); return; }
    if (draft.baseline === null && selectedProjects.length > 0 && selectedEvents.length === 0) { setValidation(m.invalidEvents); return; }
    setValidation(null); setLocalError(null);
    try {
      if (draft.baseline === null) await actions.submit({ kind: "endpoint.create", body: { name: draft.name, enabled: true, destination: { kind: "http", adapterVersion: "1", configuration: { url: draft.url } }, subscriptions: selectedProjects.map(projectId => ({ id: null, projectId, eventTypes: selectedEvents })) } });
      else if (draft.dirty.name || draft.dirty.url) await actions.submit({ kind: "endpoint.patch", endpointId: draft.baseline.id, ifVersion: draft.baseline.configVersion, destinationRevision: draft.baseline.destinationRevision, body: { ...(draft.dirty.name ? { name: draft.name } : {}), ...(draft.dirty.url ? { destination: { kind: "http", adapterVersion: "1", configuration: { url: draft.url } } } : {}) } });
    } catch (error) { setLocalError(error); }
  };
  const unchanged = draft.baseline !== null && !draft.dirty.name && !draft.dirty.url;
  const review = async () => {
    setReviewing(true);
    try { const current = await onReview(); if (current !== null) setDraft(old => reviewConfigurationDraft(old, current)); }
    catch (error) { setLocalError(error); }
    finally { setReviewing(false); }
  };
  const fieldConflict = (field: ConfigurationField) => draft.conflicts[field] && <div className="warning-box webhook-field-conflict" role="alert">
    <p>{m.fieldChanged}</p><span className="tiny">{m.currentValue}</span><div className="value-box"><span>{observedField(draft.baseline, field)}</span></div>
    <div className="webhook-field-conflict-actions"><button className="button small" type="button" onClick={() => resolveField(field, false)}>{m.useCurrent}</button><button className="button small" type="button" onClick={() => resolveField(field, true)}>{m.keepEdit}</button></div>
  </div>;
  const unavailableSelected = selectedProjects.filter(id => !projects?.some(project => project.id === id));
  return <WebhookDialog title={draft.baseline === null ? m.newTitle : m.editTitle} opener={actions.opener} onClose={actions.onClose} footer={<><button className="button" type="button" onClick={actions.onClose}>{m.cancel}</button><button className="button primary" type="submit" form={formId} disabled={!actions.canSubmit || isPending(actions.state) || unchanged || conflicts || reviewing || !actions.expansionAvailable && (draft.baseline === null || draft.dirty.url) || draft.baseline === null && projects === null}>{draft.baseline === null ? m.create : m.save}</button></>}>
    <form id={formId} className={draft.baseline === null ? "webhook-create-form" : undefined} onSubmit={event => { void submit(event); }}><WebhookPendingNotice state={actions.state} active={actions.canRead} onCheck={actions.reconcile}/>
      {validation !== null && <div className="inline-error" role="alert">{validation}</div>}{(localError ?? errorFor(actions.state)) !== null && <WebhookError error={localError ?? errorFor(actions.state)}/>}
      {actions.state.phase === "rejected" && draft.baseline !== null && <button className="text-button" type="button" disabled={reviewing || !actions.canSubmit} onClick={() => { void review(); }}>{m.reviewCurrent}</button>}
      <div className="form-field"><label htmlFor="webhook-name">{m.name}</label><input id="webhook-name" className="input" name="name" value={draft.name} placeholder={m.namePlaceholder} onChange={event => changeField("name", event.target.value)} required autoComplete="off"/>{fieldConflict("name")}</div>
      <div className="form-field"><label htmlFor="webhook-url">{m.url}</label><input id="webhook-url" className="input" name="url" type="url" value={draft.url} disabled={!actions.expansionAvailable} placeholder={m.urlPlaceholder} onChange={event => changeField("url", event.target.value)} required autoComplete="off"/>{fieldConflict("url")}{!actions.expansionAvailable && draft.dirty.url && draft.baseline !== null && <button className="text-button" type="button" onClick={() => resolveField("url", false)}>{m.useCurrent}</button>}</div>
      <div className="form-field"><span className="field-title">{m.receiveType}</span><div className="selected-type"><WebhookIcon name="code" size={20}/><div><strong>{m.method}</strong><small>CloudEvents · Standard Webhooks</small></div></div></div>
      {draft.baseline === null && <><div className="form-divider"/><fieldset className="form-field"><legend className="field-title">{m.selectProjects}</legend><div className="checkbox-list">{projects === null ? <span>{m.loading}</span> : projects.length === 0 && unavailableSelected.length === 0 ? <span className="hint">{m.noProjects}</span> : projects.map(project => <label className="check-row" key={project.id}><input type="checkbox" checked={selectedProjects.includes(project.id)} onChange={event => setSelectedProjects(event.target.checked ? [...selectedProjects, project.id] : selectedProjects.filter(id => id !== project.id))}/><span className="check-main"><strong>{project.name}</strong><small>{projectLabels.get(project.id)}</small></span></label>)}{unavailableSelected.map(id => <label className="check-row" key={id}><input type="checkbox" checked onChange={() => setSelectedProjects(old => old.filter(value => value !== id))}/><span className="check-main"><strong>{id}</strong></span></label>)}</div></fieldset><EventChecks value={selectedEvents} onChange={setSelectedEvents}/></>}
    </form>
  </WebhookDialog>;
};

export const WebhookSubscriptionDialog = ({ endpoint, subscription, projects, projectLabels, actions }: {
  readonly endpoint: WebhookActiveEndpoint; readonly subscription: WebhookSubscription | null; readonly projects: readonly Project[] | null; readonly projectLabels: ReadonlyMap<string, string>; readonly actions: WebhookFormActions;
}) => {
  const m = useWebhookMessages(), formId = useId(), [projectId, setProjectId] = useState(subscription?.projectId ?? ""), [selectedEvents, setSelectedEvents] = useState<readonly WebhookEventType[]>(subscription?.eventTypes ?? []), [validation, setValidation] = useState<string | null>(null), [localError, setLocalError] = useState<unknown>(null);
  const eligible = subscription === null || subscription.eligibility === "eligible";
  const canExpand = eligible && actions.expansionAvailable;
  const replacement: WebhookSubscriptionInput = { id: subscription !== null && subscription.projectId === projectId ? subscription.id : null, projectId, eventTypes: selectedEvents };
  const subscriptions = (subscription === null ? [...endpoint.subscriptions, replacement] : endpoint.subscriptions.map(old => old.id === subscription.id ? replacement : old)).map(({ id, projectId, eventTypes }) => ({ id, projectId, eventTypes }));
  const input: WebhookIntentInput = { kind: "endpoint.patch", endpointId: endpoint.id, ifVersion: endpoint.configVersion, destinationRevision: endpoint.destinationRevision, body: { subscriptions } };
  const expansionBlocked = !actions.expansionAvailable && webhookExpansion(input, endpoint);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!actions.canSubmit || isPending(actions.state) || expansionBlocked) return;
    if (projectId === "" || selectedEvents.length === 0) { setValidation(m.invalidEvents); return; }
    setValidation(null); setLocalError(null);
    try { await actions.submit(input); } catch (error) { setLocalError(error); }
  };
  const unavailableSelected = projectId !== "" && !projects?.some(project => project.id === projectId);
  return <WebhookDialog title={subscription === null ? m.addSub : m.editSub} opener={actions.opener} onClose={actions.onClose} footer={<><button className="button" type="button" onClick={actions.onClose}>{m.cancel}</button><button className="button primary" type="submit" form={formId} disabled={!actions.canSubmit || isPending(actions.state) || expansionBlocked || projects === null && subscription === null}>{m.save}</button></>}>
    <form id={formId} onSubmit={event => { void submit(event); }}><WebhookPendingNotice state={actions.state} active={actions.canRead} onCheck={actions.reconcile}/>{validation !== null && <div className="inline-error" role="alert">{validation}</div>}{(localError ?? errorFor(actions.state)) !== null && <WebhookError error={localError ?? errorFor(actions.state)}/>}
      <div className="form-field"><label htmlFor="webhook-subscription-project">{m.project}</label><NativeSelect layout="fill" id="webhook-subscription-project" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={!eligible || subscription === null && !actions.expansionAvailable}><option value="">{m.selectProjects}</option>{unavailableSelected && <option value={projectId}>{projectId}</option>}{projects?.map(project => <option value={project.id} key={project.id} disabled={!canExpand && project.id !== subscription?.projectId}>{project.name} · {projectLabels.get(project.id)}</option>)}</NativeSelect></div>
      <EventChecks value={selectedEvents} onChange={setSelectedEvents} canAdd={canExpand}/>
    </form>
  </WebhookDialog>;
};
