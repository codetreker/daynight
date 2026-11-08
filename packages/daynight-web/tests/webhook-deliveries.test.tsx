import { createHash, webcrypto } from "node:crypto";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseWebhookCatalog, type WebhookActiveEndpoint, type WebhookAttempt, type WebhookDelivery, type WebhookReceipt } from "../src/api/webhooks";
import type { CurrentUser } from "../src/api/auth-types";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import type { WebhookIntentInput, WebhookIntentState } from "../src/features/webhook-intents/controller";
import { WebhooksPage } from "../src/features/webhooks/WebhooksPage";
import { WebhookDeliveriesPanel, type WebhookHistoryEndpoint } from "../src/features/webhook-deliveries/WebhookDeliveriesPanel";
import { renderWithLocale } from "./helpers/renderWithLocale";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const userId = id(1), endpointId = id(2), deliveryId = id(3), eventId = id(4), projectId = id(5);
const occurred = new Date(Date.now() - 60_000).toISOString(), expires = new Date(Date.now() + 86_400_000).toISOString();
const owner = { kind: "personal" as const, id: userId };
const endpoint: WebhookActiveEndpoint = { id: endpointId, owner, lifecycle: "active", configVersion: "9223372036854775800", destinationRevision: "12", deletedAt: null, name: "Endpoint", enabled: true, destination: { kind: "http", adapterVersion: "1", url: "https://receiver.test/original?token=private", displayUrl: "https://receiver.test/original?token=private" }, signing: { scheme: "standard-webhooks-v1", activeKeyId: id(6), overlapUntil: null }, subscriptions: [], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: occurred, updatedAt: occurred };
const delivery = (number = 3): WebhookDelivery => ({ id: id(number), endpointId, eventId, owner, eventType: "task.created", resource: { projectId, taskId: id(7), stepId: null, messageId: null, displayName: "Original title" }, occurredAt: new Date(Date.parse(occurred) - (number - 3) * 1000).toISOString(), resourceVersion: "9223372036854775799", target: { destinationRevision: "12", url: endpoint.destination.url, displayUrl: endpoint.destination.displayUrl }, generation: "9223372036854775798", state: "failed", attemptCount: 1, automaticAttemptCount: 1, manualOperationCount: 0, nextAttemptAt: null, lastAttemptAt: occurred, expiresAt: expires, automaticExpiresAt: expires, payloadExpiresAt: expires, lastAcknowledgedAt: occurred, lastResult: { category: "http_error", code: "receiver_rejected", httpStatus: 503, durationMs: 20 }, payloadAvailable: true, disclosure: "full" });
const metadataDelivery = (): WebhookDelivery => ({ ...delivery(), disclosure: "metadata_only", eventType: null, resourceVersion: null, resource: { projectId: null, taskId: null, stepId: null, messageId: null, displayName: null }, target: { destinationRevision: "12", url: null, displayUrl: null }, payloadAvailable: false });
const attempt: WebhookAttempt = { id: id(10), endpointId, deliveryId, generation: "9223372036854775798", number: 1, claimedAt: occurred, admittedAt: null, dispatchedAt: null, finishedAt: null, outcome: "unknown", httpStatus: null, durationMs: null, error: { category: "unknown", code: "outcome_unknown", message: "Outcome unknown." }, recoveredUnknownAt: occurred, lateResult: { observedAt: occurred, outcome: "acknowledged", httpStatus: 202, durationMs: 20, error: null } };
const catalog = parseWebhookCatalog({ items: ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: "project" })), service: { configurationExpansionAvailable: true, dispatchEnabled: true }, limits: { policyVersion: "1", requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 10, automaticWindowSeconds: 259200, maxManualOperations: 3, payloadRetentionSeconds: 604800, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 } });
const idle: WebhookIntentState = { phase: "idle", prepared: null, result: null, error: null, reconciling: false, persistenceError: null };
const page = <T,>(items: readonly T[], nextCursor: string | null = null) => ({ items, nextCursor, historyMayBeIncomplete: true, retention: { payloadRetentionSeconds: 604800, metadataRetentionSeconds: 2592000 } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const failure = (status: number, code: string) => response({ error: { code, message: "Request failed.", requestId: "request-1" } }, status);
const barrier = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const payloadResponse = (text = '<script>window.PAYLOAD_EXECUTED=true</script>') => { const raw = Buffer.from(text); return { owner, endpointId, deliveryId, eventId, mediaType: "application/cloudevents+json", encoding: "base64", body: raw.toString("base64"), bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") }; };
beforeEach(() => vi.stubGlobal("crypto", { subtle: webcrypto.subtle }));

const mount = ({ initialId = null, items = [delivery()], interceptInitial = () => null }: { readonly initialId?: string | null; readonly items?: readonly WebhookDelivery[]; readonly interceptInitial?: (url: URL) => Promise<Response> | null } = {}) => {
  const lifetime = new AbortController(), denied = vi.fn(), submitted = vi.fn<(input: WebhookIntentInput) => Promise<WebhookIntentState>>().mockResolvedValue(idle);
  const controller = { getSnapshot: vi.fn((): WebhookIntentState => idle), forgetCurrentProjection: vi.fn(), reconcile: async () => idle };
  const admission = { userId, signal: lifetime.signal, ready: async (signal: AbortSignal) => signal.throwIfAborted(), isInvalidated: false, principalMismatch: vi.fn() } as unknown as TaskCacheScope;
  let detail = items[0] ?? delivery(), intercept: ((url: URL) => Promise<Response> | null) | null = interceptInitial;
  const fetch = vi.fn((input: string) => { const url = new URL(input, location.origin), held = intercept?.(url); if (held !== null && held !== undefined) return held; if (url.pathname.endsWith("/payload")) return Promise.resolve(response(payloadResponse())); if (url.pathname.endsWith("/attempts")) return Promise.resolve(response(page([attempt]))); if (url.pathname.endsWith("/deliveries")) return Promise.resolve(response(page(items))); return Promise.resolve(response(detail)); });
  vi.stubGlobal("fetch", fetch);
  const View = ({ visible = true, auth = "owner-1", value = endpoint, readable = true, manager = true }: { readonly visible?: boolean; readonly auth?: string; readonly value?: WebhookHistoryEndpoint; readonly readable?: boolean; readonly manager?: boolean }) => { const [selected, setSelected] = useState(initialId); return <section className="webhooks"><WebhookDeliveriesPanel owner={owner} endpoint={value} admission={admission} active={readable} visible={visible} authorizationKey={auth} catalog={catalog} controller={controller as never} intent={idle} submit={submitted} onOwnerDenied={denied} onRefreshEndpoint={() => {}} routeDeliveryId={selected} onSelectDelivery={setSelected} manageOwner={manager}/></section>; };
  const rendered = renderWithLocale(<View/>, { locale: "en" });
  return { ...rendered, denied, submitted, fetch, controller, setDetail: (value: WebhookDelivery) => { detail = value; }, intercept: (read: typeof intercept) => { intercept = read; }, rerenderView: (props: Parameters<typeof View>[0]) => rendered.rerender(<View {...props}/>) };
};
const open = async () => { const row = await screen.findByRole("button", { name: /task.created.*Failed/ }); fireEvent.click(row); return screen.findByRole("dialog", { name: "Delivery details" }); };

describe("webhook delivery diagnostics", () => {
  it.each(["delivered", "failed", "pending", "leased", "suppressed"] as const)("renders the %s delivery status widget consistently in rows and details", async state => {
    const view = mount({ items: [{ ...delivery(), state }] });
    const row = await waitFor(() => { const node = view.container.querySelector<HTMLButtonElement>(".delivery-row"); expect(node).not.toBeNull(); return node!; });
    fireEvent.click(row); const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Original title");
    for (const badge of [row.querySelector(".badge"), dialog.querySelector(".delivery-summary .badge")]) {
      expect(badge).not.toBeNull(); const icons = badge!.querySelectorAll("svg");
      expect(icons).toHaveLength(state === "suppressed" ? 0 : 1);
      if (state !== "suppressed") { expect(icons[0]).toHaveAttribute("width", "11"); expect(icons[0]).toHaveAttribute("height", "11"); expect(icons[0]).toHaveAttribute("aria-hidden", "true"); }
    }
  });
  it("reads payload only explicitly and renders exact inert text, while separating historic acknowledgement from failure and late result", async () => {
    const view = mount(); const dialog = await open();
    expect(view.fetch.mock.calls.filter(([url]) => url.endsWith("/payload"))).toHaveLength(0);
    expect(within(dialog).getByText("Historical acknowledgement")).toBeVisible();
    expect(within(dialog).getByText("Latest result")).toBeVisible();
    await within(dialog).findByText("Late result");
    expect(within(dialog).getByText("Dispatched").nextElementSibling).toHaveTextContent("—");
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" }));
    const code = await within(dialog).findByLabelText("Event payload");
    expect(code.textContent).toBe('<script>window.PAYLOAD_EXECUTED=true</script>');
    expect(code.querySelector("script")).toBeNull();
    expect(sessionStorage.length).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide payload" })); expect(within(dialog).queryByLabelText("Event payload")).toBeNull();
  });
  it("withdraws private fields for a same-generation metadata projection and prevents held payload from reinstalling bytes", async () => {
    const view = mount(); const dialog = await open(), held = barrier<Response>();
    view.intercept(url => url.pathname.endsWith("/payload") ? held.promise : null);
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" }));
    const redacted = { ...delivery(), disclosure: "metadata_only" as const, eventType: null, resourceVersion: null, resource: { projectId: null, taskId: null, stepId: null, messageId: null, displayName: null }, target: { destinationRevision: "12", url: null, displayUrl: null }, payloadAvailable: false };
    view.setDetail(redacted); view.intercept(url => url.pathname.endsWith("/payload") ? held.promise : url.pathname.endsWith("/deliveries") ? Promise.resolve(response(page([redacted]))) : null);
    fireEvent.focus(window); await within(dialog).findByText("You no longer have access to this event. Private event data has been removed.");
    expect(dialog).not.toHaveTextContent("Original title"); expect(dialog).not.toHaveTextContent("token=private");
    await act(async () => held.resolve(response(payloadResponse())));
    expect(within(dialog).queryByLabelText("Event payload")).toBeNull(); expect(view.denied).not.toHaveBeenCalled();
  });
  it("shares a disclosure epoch between a newer metadata detail and an earlier full list, and permits a fresh grant", async () => {
    const view = mount(); const dialog = await open(), heldList = barrier<Response>();
    view.setDetail(metadataDelivery()); view.intercept(url => url.pathname.endsWith("/deliveries") ? heldList.promise : null);
    fireEvent.focus(window); await within(dialog).findByText("You no longer have access to this event. Private event data has been removed.");
    await act(async () => heldList.resolve(response(page([delivery()]))));
    expect(document.body).not.toHaveTextContent("Original title"); expect(document.body).not.toHaveTextContent("token=private"); expect(screen.queryByRole("button", { name: /task.created.*Failed/ })).toBeNull();
    view.intercept(null); view.setDetail(delivery()); fireEvent.focus(window);
    await within(dialog).findByText("Original title"); expect(view.denied).not.toHaveBeenCalled(); expect(view.submitted).not.toHaveBeenCalled(); expect(within(dialog).queryByLabelText("Event payload")).toBeNull();
  });
  it("shares a newer metadata list restriction with an earlier held full detail", async () => {
    const view = mount(); const dialog = await open(), heldDetail = barrier<Response>();
    view.intercept(url => url.pathname.endsWith(`/deliveries/${deliveryId}`) ? heldDetail.promise : url.pathname.endsWith("/deliveries") ? Promise.resolve(response(page([metadataDelivery()]))) : null);
    fireEvent.focus(window); await within(dialog).findByText("You no longer have access to this event. Private event data has been removed.");
    await act(async () => heldDetail.resolve(response(delivery())));
    expect(document.body).not.toHaveTextContent("Original title"); expect(document.body).not.toHaveTextContent("token=private"); expect(view.denied).not.toHaveBeenCalled(); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("shares a payload denial with earlier held full list and detail reads without revoking the owner", async () => {
    const view = mount(); const dialog = await open(), heldList = barrier<Response>(), heldDetail = barrier<Response>();
    view.intercept(url => url.pathname.endsWith("/payload") ? Promise.resolve(failure(403, "forbidden")) : url.pathname.endsWith("/deliveries") ? heldList.promise : url.pathname.endsWith(`/deliveries/${deliveryId}`) ? heldDetail.promise : null);
    fireEvent.focus(window); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); await within(dialog).findByText("forbidden", { exact: false });
    await act(async () => { heldList.resolve(response(page([delivery()]))); heldDetail.resolve(response(delivery())); });
    expect(document.body).not.toHaveTextContent("Original title"); expect(document.body).not.toHaveTextContent("token=private"); expect(within(dialog).queryByLabelText("Event payload")).toBeNull(); expect(view.denied).not.toHaveBeenCalled(); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("keeps old events with currently retained activity visible and withdraws them only after an authoritative GET reports disappearance", async () => {
    const startedAt = Date.now(), heldList = barrier<Response>(), heldDetail = barrier<Response>();
    const value: WebhookDelivery = { ...delivery(), occurredAt: new Date(startedAt - 40 * 86_400_000).toISOString(), lastAttemptAt: new Date(startedAt - 20 * 86_400_000).toISOString(), payloadExpiresAt: new Date(startedAt - 1000).toISOString(), payloadAvailable: false, lastAcknowledgedAt: null };
    vi.useFakeTimers(); vi.setSystemTime(startedAt);
    try {
      const view = mount({ initialId: deliveryId, items: [value], interceptInitial: url => url.pathname.endsWith("/deliveries") ? heldList.promise : url.pathname.endsWith(`/deliveries/${deliveryId}`) ? heldDetail.promise : null });
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); heldList.resolve(response(page([value]))); heldDetail.resolve(response(value)); await vi.advanceTimersByTimeAsync(0); });
      expect(document.body).toHaveTextContent("Original title"); expect(document.body).toHaveTextContent("token=private"); expect(document.body).not.toHaveTextContent("This history has expired");
      view.intercept(url => url.pathname.endsWith(`/deliveries/${deliveryId}`) ? Promise.resolve(failure(404, "not_found")) : url.pathname.endsWith("/deliveries") ? Promise.resolve(response(page([]))) : null);
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(document.body).not.toHaveTextContent("Original title"); expect(document.body).not.toHaveTextContent("token=private"); expect(document.body).toHaveTextContent("This history has expired; its absence does not mean the event never occurred."); expect(view.submitted).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("records an initial authoritative disappearance before any positive generation, preventing an earlier list from installing private data", async () => {
    const held = barrier<Response>(); const view = mount({ initialId: deliveryId, interceptInitial: url => url.pathname.endsWith("/deliveries") ? held.promise : url.pathname.endsWith(`/deliveries/${deliveryId}`) ? Promise.resolve(failure(404, "not_found")) : null });
    await screen.findByText("This history has expired; its absence does not mean the event never occurred.");
    await act(async () => held.resolve(response(page([delivery()]))));
    expect(document.body).not.toHaveTextContent("Original title"); expect(document.body).not.toHaveTextContent("token=private");
    view.intercept(null); fireEvent.focus(window); await within(screen.getByRole("dialog")).findByText("Original title"); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("fences an initial URL-only restricted detail against an earlier full list and forgets a private current write projection", async () => {
    const held = barrier<Response>(), limited: WebhookDelivery = { ...delivery(), target: { ...delivery().target, url: null, displayUrl: "https://receiver.test/…" } };
    const view = mount({ initialId: deliveryId, interceptInitial: url => url.pathname.endsWith("/deliveries") ? held.promise : url.pathname.endsWith(`/deliveries/${deliveryId}`) ? Promise.resolve(response(limited)) : null });
    const receipt: WebhookReceipt = { operationId: id(90), kind: "delivery.redeliver", issuedAt: occurred, requestSha256: "a".repeat(64), actorUserId: userId, owner, endpointId, effect: "applied", configVersionAfter: endpoint.configVersion, destinationRevisionAfter: "12", deliveryId, generationAfter: delivery().generation, keyId: null, overlapUntil: null, recordedAt: occurred, expiresAt: expires };
    view.controller.getSnapshot.mockReturnValue({ ...idle, phase: "confirmed", result: { operation: receipt, delivery: delivery() } });
    const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("https://receiver.test/…");
    await act(async () => held.resolve(response(page([delivery()]))));
    expect(document.body).not.toHaveTextContent("token=private"); expect(within(dialog).getByRole("button", { name: /^Redeliver$/ })).toBeDisabled(); expect(view.controller.forgetCurrentProjection).toHaveBeenCalled(); expect(view.controller.getSnapshot().result?.operation).toBe(receipt);
    view.intercept(null); view.setDetail(delivery()); fireEvent.focus(window); await within(dialog).findByText(endpoint.destination.url!); expect(view.denied).not.toHaveBeenCalled(); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("shares a URL-only list restriction with an earlier full detail while retaining authorized resource information", async () => {
    const view = mount(); const dialog = await open(), held = barrier<Response>();
    const limited = { ...delivery(), target: { ...delivery().target, url: null, displayUrl: "https://receiver.test/…" } };
    view.intercept(url => url.pathname.endsWith("/deliveries") ? Promise.resolve(response(page([limited]))) : url.pathname.endsWith(`/deliveries/${deliveryId}`) ? held.promise : null);
    fireEvent.focus(window); await within(dialog).findByText("https://receiver.test/…"); await act(async () => held.resolve(response(delivery())));
    expect(document.body).not.toHaveTextContent("token=private"); expect(within(dialog).getByText("Original title")).toBeVisible(); expect(view.denied).not.toHaveBeenCalled(); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("withdraws the selected history, payload and confirmation after an authoritative Attempt404 and fences earlier full reads", async () => {
    const view = mount(); const dialog = await open(); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); await within(dialog).findByLabelText("Event payload"); fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ }));
    const heldList = barrier<Response>(), heldDetail = barrier<Response>();
    view.intercept(url => url.pathname.endsWith("/attempts") ? Promise.resolve(failure(404, "not_found")) : url.pathname.endsWith("/deliveries") ? heldList.promise : url.pathname.endsWith(`/deliveries/${deliveryId}`) ? heldDetail.promise : null);
    fireEvent.focus(window); await within(dialog).findByText("This history has expired; its absence does not mean the event never occurred.");
    expect(within(dialog).queryByLabelText("Event payload")).toBeNull(); expect(within(dialog).queryByText("Confirm redelivery")).toBeNull();
    await act(async () => { heldList.resolve(response(page([delivery()]))); heldDetail.resolve(response(delivery())); });
    expect(document.body).not.toHaveTextContent("Original title"); expect(document.body).not.toHaveTextContent("token=private"); expect(view.denied).not.toHaveBeenCalled(); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("ignores an Attempt404 belonging to an earlier selection after another delivery is opened", async () => {
    const next: WebhookDelivery = { ...delivery(8), eventId: id(9), resource: { ...delivery(8).resource, displayName: "Next delivery" } }, held = barrier<Response>();
    const view = mount({ initialId: deliveryId, items: [next, delivery()], interceptInitial: url => url.pathname.includes(`/deliveries/${deliveryId}/attempts`) ? held.promise : url.pathname.endsWith(`/deliveries/${deliveryId}`) ? Promise.resolve(response(delivery())) : url.pathname.endsWith(`/deliveries/${next.id}`) ? Promise.resolve(response(next)) : url.pathname.includes(`/deliveries/${next.id}/attempts`) ? Promise.resolve(response(page([]))) : url.pathname.includes(`/deliveries/${next.id}/payload`) ? Promise.resolve(response({ ...payloadResponse(), deliveryId: next.id, eventId: next.eventId })) : null });
    const initial = await screen.findByRole("dialog"); await within(initial).findByText("Original title"); fireEvent.click(within(initial).getAllByRole("button", { name: "Close" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: /Next delivery/ })); const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Next delivery"); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); const code = await within(dialog).findByLabelText("Event payload"); fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ }));
    await act(async () => held.resolve(failure(404, "not_found")));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(within(dialog).getByText("Confirm redelivery")).toBeVisible(); expect(within(dialog).getByText("Next delivery")).toBeVisible(); expect(view.denied).not.toHaveBeenCalled(); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("treats payload 403 as a resource denial and keeps its error visible without revoking the owner", async () => {
    const view = mount(); const dialog = await open(); view.intercept(url => url.pathname.endsWith("/payload") ? Promise.resolve(failure(403, "forbidden")) : null);
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); await within(dialog).findByText("forbidden", { exact: false });
    expect(view.denied).not.toHaveBeenCalled(); expect(dialog).not.toHaveTextContent("token=private"); expect(within(dialog).queryByLabelText("Event payload")).toBeNull();
  });
  it("preserves loaded pages and displayed DOM during background reads, and refuses a duplicate cursor", async () => {
    const view = mount(); view.intercept(url => url.pathname.endsWith("/deliveries") ? Promise.resolve(response(url.searchParams.get("cursor") === null ? page([delivery()], "page-2") : page([delivery(8)]))) : null);
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" })); await screen.findByRole("button", { name: "Load more" }); fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /task.created.*Failed/ })).toHaveLength(2));
    const row = screen.getAllByRole("button", { name: /task.created.*Failed/ })[0]!, held = barrier<Response>();
    view.intercept(url => url.pathname.endsWith("/deliveries") && url.searchParams.get("cursor") === null ? held.promise : url.pathname.endsWith("/deliveries") ? Promise.resolve(response(page([delivery(8)]))) : null);
    fireEvent.focus(window); expect(row.isConnected).toBe(true); expect(screen.getAllByRole("button", { name: /task.created.*Failed/ })).toHaveLength(2);
    await act(async () => held.resolve(response(page([delivery()], "page-2")))); await waitFor(() => expect(view.fetch.mock.calls.filter(([url]) => url.includes("cursor=page-2")).length).toBeGreaterThanOrEqual(2)); expect(row.isConnected).toBe(true);
    view.intercept(url => url.pathname.endsWith("/deliveries") ? Promise.resolve(response(page([delivery()], "loop"))) : null);
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" })); await screen.findByText("The server returned an invalid response.", { exact: false }); expect(row.isConnected).toBe(true); expect(screen.getAllByRole("button", { name: /task.created.*Failed/ })).toHaveLength(2);
  });
  it("keeps a modal and payload node through unchanged focus/language checks and clears plaintext on exit", async () => {
    const view = mount(); const dialog = await open(); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); const code = await within(dialog).findByLabelText("Event payload");
    fireEvent.focus(window); await waitFor(() => expect(view.fetch.mock.calls.filter(([url]) => url.includes(`/deliveries/${deliveryId}`)).length).toBeGreaterThan(2));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code);
    view.setLocale("zh-CN"); expect(screen.getByRole("dialog")).toBe(dialog); expect(code.isConnected).toBe(true);
    fireEvent.click(within(dialog).getAllByRole("button", { name: "关闭" })[1]!); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.body).not.toHaveTextContent("PAYLOAD_EXECUTED");
  });
  it("preserves a validated dialog, payload, confirmation, drafts and focus throughout an unchanged admission pause", async () => {
    const view = mount(); const dialog = await open(); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" }));
    const code = await within(dialog).findByLabelText("Event payload"); fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ }));
    const decision = within(dialog).getByText("Confirm redelivery"), generationInput = within(dialog).getByLabelText("Generation") as HTMLInputElement;
    fireEvent.change(generationInput, { target: { value: "1234567" } }); generationInput.focus(); generationInput.setSelectionRange(2, 5);
    const held = barrier<Response>(); view.intercept(url => url.pathname.endsWith(`/deliveries/${deliveryId}`) ? held.promise : null);
    view.rerenderView({ readable: false }); const before = view.fetch.mock.calls.length; fireEvent.focus(window);
    await act(async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); });
    expect(view.fetch.mock.calls.length).toBe(before); expect(view.submitted).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(within(dialog).getByText("Confirm redelivery")).toBe(decision);
    expect(document.activeElement).toBe(generationInput); expect(generationInput.value).toBe("1234567"); expect([generationInput.selectionStart, generationInput.selectionEnd]).toEqual([2, 5]);
    view.rerenderView({ readable: true }); await waitFor(() => expect(view.fetch.mock.calls.length).toBeGreaterThan(before));
    expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(within(dialog).getByText("Confirm redelivery")).toBe(decision);
    await act(async () => held.resolve(response(delivery())));
    expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(generationInput.value).toBe("1234567"); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("withdraws plaintext for a confirmed authorization epoch change and refuses an earlier payload result", async () => {
    const view = mount(); const dialog = await open(), held = barrier<Response>();
    view.intercept(url => url.pathname.endsWith("/payload") ? held.promise : null); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" }));
    view.rerenderView({ readable: false, auth: "revoked" }); expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => held.resolve(response(payloadResponse()))); expect(document.body).not.toHaveTextContent("PAYLOAD_EXECUTED"); expect(view.submitted).not.toHaveBeenCalled();
  });
  it("supports deep links and submits observed int64 versions with an explicit decision", async () => {
    const view = mount({ initialId: deliveryId }); const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Original title");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ })); expect(view.submitted).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Register redelivery$/ })); await waitFor(() => expect(view.submitted).toHaveBeenCalledTimes(1));
    expect(view.submitted).toHaveBeenCalledWith({ kind: "delivery.redeliver", endpointId, deliveryId, ifVersion: endpoint.configVersion, ifGeneration: delivery().generation, destinationRevision: "12", body: {} });
  });
  it("shows retained deleted-endpoint history and authorized payload without creating capabilities or enabling redelivery", async () => {
    const value = { ...delivery(), target: { ...delivery().target, url: null, displayUrl: "https://receiver.test/…" } };
    const view = mount({ initialId: deliveryId, items: [value] });
    view.rerenderView({ value: { id: endpointId, owner, lifecycle: "deleted", configVersion: "9223372036854775801", deletedAt: occurred }, manager: false });
    const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Original title");
    expect(within(dialog).getByRole("button", { name: /^Redeliver$/ })).toBeDisabled();
    expect(dialog).not.toHaveTextContent("token=private");
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); await within(dialog).findByLabelText("Event payload");
    expect(view.submitted).not.toHaveBeenCalled(); expect(view.denied).not.toHaveBeenCalled();
    expect(within(dialog).getAllByRole("button", { name: "Close" })[1]).toBeVisible();
  });
  it("uses an explicit ID-only retained-history context without inventing an endpoint version or capabilities", async () => {
    const view = mount({ initialId: deliveryId }); view.rerenderView({ value: { kind: "retained-history", id: endpointId } });
    const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Original title");
    expect(within(dialog).getByRole("button", { name: /^Redeliver$/ })).toBeDisabled();
    expect(within(dialog).queryByText("Confirm redelivery")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); await within(dialog).findByLabelText("Event payload");
    expect(view.submitted).not.toHaveBeenCalled(); expect(view.denied).not.toHaveBeenCalled();
  });
  it("opens the retained-history page after a real endpoint404 and preserves its dialog during an unchanged admission pause", async () => {
    const lifetime = new AbortController(), admission = { userId, signal: lifetime.signal, ready: async (signal: AbortSignal) => signal.throwIfAborted(), isInvalidated: false, principalMismatch: vi.fn() } as unknown as TaskCacheScope;
    const user: CurrentUser = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: id(20), kind: "personal", name: null } };
    const fetch = vi.fn((input: string) => { const url = new URL(input, location.origin); if (url.pathname === "/api/v1/projects" || url.pathname === "/api/v1/teams" || url.pathname === "/api/v1/me/webhooks") return Promise.resolve(response({ items: [], nextCursor: null })); if (url.pathname === `/api/v1/me/webhooks/${endpointId}`) return Promise.resolve(failure(404, "not_found")); if (url.pathname.endsWith("/deliveries")) return Promise.resolve(response(page([delivery()]))); if (url.pathname.endsWith("/attempts")) return Promise.resolve(response(page([attempt]))); if (url.pathname.endsWith("/payload")) return Promise.resolve(response(payloadResponse())); if (url.pathname.endsWith(`/deliveries/${deliveryId}`)) return Promise.resolve(response(delivery())); throw new Error(`Unexpected request: ${url.pathname}`); });
    vi.stubGlobal("fetch", fetch);
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }; vi.stubGlobal("matchMedia", () => media);
    const route = { kind: "webhooks" as const, owner: "personal" as const, teamId: null, endpointId, tab: "deliveries" as const, deliveryId, error: null };
    const rendered = renderWithLocale(<WebhooksPage user={user} admission={admission} active route={route} catalog={catalog}/>, { locale: "en" });
    const dialog = await screen.findByRole("dialog"), title = await within(dialog).findByText("Original title"); expect(screen.getByRole("heading", { name: "Delivery history" })).toBeVisible(); expect(within(dialog).getByRole("button", { name: /^Redeliver$/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); const code = await within(dialog).findByLabelText("Event payload");
    rendered.rerender(<WebhooksPage user={user} admission={admission} active={false} route={route} catalog={catalog}/>);
    expect(screen.getByRole("dialog")).toBe(dialog); expect(title.isConnected).toBe(true); expect(code.isConnected).toBe(true); expect(within(dialog).getByLabelText("Event payload")).toBe(code);
  });
  it("starts no history reads while owner access is unknown, and rejects an overly disclosing target for a confirmed reader", async () => {
    const view = mount(); view.rerenderView({ readable: false, manager: false, auth: "unknown" });
    const before = view.fetch.mock.calls.length; await act(async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); });
    expect(view.fetch.mock.calls.length).toBe(before);
    view.rerenderView({ manager: false, auth: "reader" });
    await screen.findByRole("alert"); expect(document.body).not.toHaveTextContent("Original title"); expect(document.body).not.toHaveTextContent("token=private");
    expect(view.denied).not.toHaveBeenCalled();
  });
  it("keeps filter drafts local and sends valid filters to the service rather than filtering the loaded page", async () => {
    const view = mount(); await screen.findByRole("button", { name: /task.created.*Failed/ }); fireEvent.click(screen.getByRole("button", { name: "Filter history" }));
    fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "task.paused" } }); fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "101" } }); fireEvent.click(screen.getByRole("button", { name: "Apply filters" })); await screen.findByRole("alert"); expect(view.fetch.mock.calls.some(([url]) => url.includes("eventType=task.paused"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Page size"), { target: { value: "100" } }); fireEvent.click(screen.getByRole("button", { name: "Apply filters" })); await waitFor(() => expect(view.fetch.mock.calls.some(([url]) => url.includes("eventType=task.paused") && url.includes("limit=100"))).toBe(true)); expect(location.search).not.toContain("task.paused");
  });
});
