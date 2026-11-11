import { createHash, randomUUID, webcrypto } from "node:crypto";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { browserNavigation } from "../src/app/navigation";
import { navigate, parseAuthRoute, webhookUrl } from "../src/app/router";
import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../src/api/auth-types";
import { parseWebhookCatalog, type WebhookActiveEndpoint, type WebhookDelivery, type WebhookReceipt } from "../src/api/webhooks";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { WebhooksPage } from "../src/features/webhooks/WebhooksPage";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";
import { renderWithLocale } from "./helpers/renderWithLocale";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1), teamId = id(2), endpointId = id(3), deliveryId = id(4), eventId = id(5), projectId = id(6), happened = new Date(Date.now() - 60_000).toISOString(), expires = new Date(Date.now() + 86_400_000).toISOString();
const owner = { kind: "team" as const, id: teamId };
const user: CurrentUser = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: id(10), kind: "personal", name: null } };
const endpoint: WebhookActiveEndpoint = { id: endpointId, owner, lifecycle: "active", configVersion: "1", destinationRevision: "1", deletedAt: null, name: "Shared endpoint", enabled: true, destination: { kind: "http", adapterVersion: "1", url: "https://receiver.example/hooks?private=hidden", displayUrl: "https://receiver.example/hooks?private=hidden" }, signing: { scheme: "standard-webhooks-v1", activeKeyId: id(7), overlapUntil: null }, subscriptions: [], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: happened, updatedAt: happened };
const delivery: WebhookDelivery = { id: deliveryId, endpointId, eventId, owner, eventType: "task.created", resource: { projectId, taskId: id(8), stepId: null, messageId: null, displayName: "Retained history" }, resourceVersion: "1", occurredAt: happened, target: { destinationRevision: "1", url: endpoint.destination.url, displayUrl: endpoint.destination.displayUrl }, generation: "1", state: "failed", attemptCount: 1, automaticAttemptCount: 1, manualOperationCount: 0, nextAttemptAt: null, lastAttemptAt: happened, expiresAt: expires, automaticExpiresAt: expires, payloadExpiresAt: expires, lastAcknowledgedAt: null, lastResult: { category: "http_error", code: "receiver_rejected", httpStatus: 503, durationMs: 15 }, payloadAvailable: true, disclosure: "full" };
const nextDelivery: WebhookDelivery = { ...delivery, id: id(20), eventId: id(21), occurredAt: new Date(Date.parse(happened) + 1000).toISOString(), resource: { ...delivery.resource, displayName: "Next history" }, generation: "7" };
const catalog = parseWebhookCatalog({ items: ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: "project" })), service: { configurationExpansionAvailable: true, dispatchEnabled: true }, limits: { policyVersion: "1", requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 10, automaticWindowSeconds: 259200, maxManualOperations: 3, payloadRetentionSeconds: 604800, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const failure = () => response({ error: { code: "not_found", message: "History unavailable.", requestId: "request-1" } }, 404);
const page = (items: readonly unknown[]) => ({ items, nextCursor: null, historyMayBeIncomplete: true, retention: { payloadRetentionSeconds: 604800, metadataRetentionSeconds: 2592000 } });
const barrier = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

const mount = ({ configuration = "normal", holdConfiguration = false }: { readonly configuration?: "normal" | "missing" | "failed"; readonly holdConfiguration?: boolean } = {}) => {
  mockSidebarMediaQuery();
  const lifetime = new AbortController(), admission = { userId, signal: lifetime.signal, ready: async (signal: AbortSignal) => signal.throwIfAborted(), isInvalidated: false, principalMismatch: vi.fn() } as unknown as TaskCacheScope;
  const state = { limited: false, missing: false, holdContext: false, holdDigest: false, configuration, holdConfiguration, ownerDenied: false, resourceDenied: false, rejectRedelivery: false, loseWrite: false, receiptMissing: false, receiptDenied: false, holdReceipt: false }, receiptHold = barrier<Response>(), configurationHold = barrier<Response>(), context = barrier<Response>(), heldDetail = barrier<Response>(), heldDigest = barrier<ArrayBuffer>();
  let digestBytes: Uint8Array<ArrayBuffer> | null = null;
  vi.stubGlobal("crypto", { randomUUID, subtle: { digest: (algorithm: string, bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> => { if (state.holdDigest) { digestBytes = bytes.slice(); return heldDigest.promise; } return webcrypto.subtle.digest(algorithm, bytes); } } });
  const writes: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  let currentDelivery = delivery; const receipts = new Map<string, WebhookReceipt>();
  const payloadText = "retained payload", raw = Buffer.from(payloadText), base = `/api/v1/teams/${teamId}/webhooks`;
  const projectedDelivery = () => state.resourceDenied ? { ...currentDelivery, disclosure: "metadata_only", eventType: null, resourceVersion: null, resource: { projectId: null, taskId: null, stepId: null, messageId: null, displayName: null }, target: { ...currentDelivery.target, url: null, displayUrl: null }, payloadAvailable: false } : state.limited ? { ...currentDelivery, target: { ...currentDelivery.target, url: null, displayUrl: "https://receiver.example/…" } } : currentDelivery;
  const fetch = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin), path = url.pathname;
    if ((init.method ?? "GET") !== "GET") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push({ path, body });
      if (state.missing) return Promise.resolve(failure());
      if (state.rejectRedelivery) return Promise.resolve(response({ error: { code: "forbidden", message: "Redelivery denied.", requestId: "redelivery-denial" } }, 403));
      const operation: WebhookReceipt = { operationId: String(body.operationId), kind: "delivery.redeliver", issuedAt: String(body.issuedAt), requestSha256: createHash("sha256").update(String(init.body)).digest("hex"), actorUserId: userId, owner, endpointId, effect: "applied", configVersionAfter: "1", destinationRevisionAfter: "1", deliveryId, generationAfter: "2", keyId: null, overlapUntil: null, recordedAt: happened, expiresAt: expires };
      currentDelivery = { ...delivery, generation: "2", manualOperationCount: 1, state: "pending", nextAttemptAt: new Date().toISOString() }; receipts.set(operation.operationId, operation);
      if (state.loseWrite) { state.loseWrite = false; return Promise.reject(new Error("Connection lost after commit")); }
      return Promise.resolve(response({ operation, delivery: currentDelivery }, 202));
    }
    const operationId = /\/operations\/([^/]+)$/.exec(path)?.[1];
    if (operationId !== undefined) return state.holdReceipt ? receiptHold.promise.then(value => value.clone()) : Promise.resolve(state.receiptDenied ? response({ error: { code: "forbidden", message: "Owner access denied.", requestId: "receipt-denial" } }, 403) : state.receiptMissing || !receipts.has(operationId) ? failure() : response(receipts.get(operationId)));
    if (state.ownerDenied) return Promise.resolve(response({ error: { code: "forbidden", message: "Owner access denied.", requestId: "owner-denial" } }, 403));
    if (state.holdContext && ["/api/v1/teams", base, `${base}/${endpointId}`].includes(path)) return context.promise;
    if (state.holdConfiguration && path === `${base}/${endpointId}`) return configurationHold.promise;
    if (path === "/api/v1/teams") return Promise.resolve(response({ items: [{ id: teamId, kind: "ordinary", name: "Engineering", version: 1, createdAt: happened, updatedAt: happened, membership: { teamId, userId, role: state.limited ? "member" : "admin", version: state.limited ? 2 : 1, createdAt: happened, updatedAt: happened } }], nextCursor: null }));
    if (path === "/api/v1/projects") return Promise.resolve(response({ items: [], nextCursor: null }));
    if (path === base) return Promise.resolve(response({ items: state.configuration === "missing" ? [] : [{ id: endpointId, owner, name: endpoint.name, enabled: true, configVersion: "1", destination: state.limited ? { ...endpoint.destination, url: null, displayUrl: "https://receiver.example/…" } : endpoint.destination, projectCount: 0, eventTypeCount: 0, lastAttemptAt: happened, lastResult: null }], nextCursor: null }));
    if (path === `${base}/${endpointId}`) return Promise.resolve(state.configuration === "missing" ? failure() : state.configuration === "failed" ? response({ error: { code: "configuration_unavailable", message: "Configuration read failed.", requestId: "config-failure" } }, 500) : response(state.limited ? { ...endpoint, destination: { ...endpoint.destination, url: null, displayUrl: "https://receiver.example/…" }, capabilities: { manage: false, readSecret: false, redeliver: false } } : endpoint));
    if (path.endsWith("/attempts")) return Promise.resolve(state.missing ? failure() : response(page([])));
    if (path.endsWith("/payload")) { const isNext = path.includes(nextDelivery.id); return Promise.resolve(response({ owner, endpointId, deliveryId: isNext ? nextDelivery.id : deliveryId, eventId: isNext ? nextDelivery.eventId : eventId, mediaType: "application/cloudevents+json", encoding: "base64", body: raw.toString("base64"), bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") })); }
    if (path.endsWith("/deliveries")) return Promise.resolve(response(page(state.missing ? [] : [projectedDelivery(), nextDelivery])));
    if (path.endsWith(`/deliveries/${nextDelivery.id}`)) return Promise.resolve(response(nextDelivery));
    if (path.endsWith(`/deliveries/${deliveryId}`)) return state.missing ? heldDetail.promise : Promise.resolve(response(projectedDelivery()));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  const route = { kind: "webhooks" as const, owner: "team" as const, teamId, endpointId, tab: "deliveries" as const, deliveryId, error: null };
  act(() => navigate(webhookUrl(route)));
  const View = () => { const navigation = browserNavigation(), location = useSyncExternalStore(navigation.subscribe, navigation.snapshot), current = parseAuthRoute(location.pathname, location.search); return current.kind === "webhooks" ? <WebhooksPage user={user} admission={admission} active route={current} catalog={catalog}/> : null; };
  const rendered = renderWithLocale(<View/>, { locale: "en" });
  return { ...rendered, state, writes, fetch, receipts, releaseReceiptDenial: () => { state.holdReceipt = false; receiptHold.resolve(response({ error: { code: "forbidden", message: "Owner access denied.", requestId: "receipt-denial" } }, 403)); }, digestBytes: () => digestBytes, releaseConfigurationFailure: () => { state.holdConfiguration = false; state.configuration = "failed"; configurationHold.resolve(response({ error: { code: "configuration_unavailable", message: "Configuration read failed.", requestId: "config-failure" } }, 500)); }, releaseDigest: async () => { state.holdDigest = false; heldDigest.resolve(await webcrypto.subtle.digest("SHA-256", digestBytes!)); } };
};


describe("webhook delivery admission in the complete page", () => {
  it("shows a selected collection failure independently of retained configuration absence", async () => {
    const view = mount({ configuration: "missing" }), dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Retained history");
    await screen.findByText("The endpoint configuration is unavailable. Retained history remains available under its current access policy.");
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); const payload = await within(dialog).findByLabelText("Event payload"); payload.focus();
    const originalFetch = view.fetch.getMockImplementation()!; let listReads = 0;
    view.fetch.mockImplementation((input, init = {}) => {
      if (new URL(input, location.origin).pathname === `/api/v1/teams/${teamId}/webhooks`) {
        listReads++;
        return Promise.resolve(response({ error: { code: "list_unavailable", message: "List read failed.", requestId: "list-failure" } }, 503));
      }
      return originalFetch(input, init);
    });
    fireEvent.focus(window); await waitFor(() => expect(listReads).toBeGreaterThan(0));
    const detail = document.querySelector<HTMLElement>(".detail-panel")!;
    await within(detail).findByText("list_unavailable", { exact: false }); expect(within(detail).getByRole("button", { name: "Retry", hidden: true })).toBeEnabled();
    expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(payload); expect(payload).toHaveFocus(); expect(view.writes).toHaveLength(0);
  });
  it("withdraws owner management without withdrawing readable resource payload when a Delivery target is restricted", async () => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history");
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); const code = await within(dialog).findByLabelText("Event payload");
    view.state.limited = true; view.state.holdContext = true; fireEvent.focus(window);
    await waitFor(() => expect(document.body).not.toHaveTextContent("private=hidden"));
    expect(screen.getByText("Member · Read only")).toBeVisible(); expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(within(dialog).getByText("Retained history")).toBeVisible(); expect(view.writes).toHaveLength(0);
  });
  it.each(["missing", "checking"] as const)("keeps %s history, payload, focus and reads through a configuration500", async initial => {
    const view = mount(initial === "missing" ? { configuration: "missing" } : { holdConfiguration: true });
    const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history"); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" }));
    const code = await within(dialog).findByLabelText("Event payload"); code.focus(); const range = document.createRange(); range.selectNodeContents(code); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    if (initial === "checking") view.releaseConfigurationFailure(); else { view.state.configuration = "failed"; fireEvent.focus(window); }
    await screen.findByText("configuration_unavailable", { exact: false });
    expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(document.activeElement).toBe(code); expect(selection.toString()).toBe("retained payload"); expect(within(dialog).getByRole("button", { name: /^Redeliver$/ })).toBeDisabled();
    if (initial === "missing") expect(screen.getByText("The endpoint configuration is unavailable. Retained history remains available under its current access policy.")).toBeVisible();
    const reads = view.fetch.mock.calls.filter(([url]) => url.endsWith(`/deliveries/${deliveryId}`)).length; fireEvent.focus(window); await waitFor(() => expect(view.fetch.mock.calls.filter(([url]) => url.endsWith(`/deliveries/${deliveryId}`)).length).toBeGreaterThan(reads)); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(view.writes).toHaveLength(0);
    view.state.configuration = "normal"; fireEvent.focus(window); await screen.findByRole("heading", { name: "Shared endpoint" });
    expect(screen.queryByText("The endpoint configuration is unavailable. Retained history remains available under its current access policy.")).toBeNull(); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(within(dialog).getByRole("button", { name: /^Redeliver$/ })).toBeEnabled();
    view.state.missing = true; fireEvent.focus(window); await within(dialog).findByText("This history has expired; its absence does not mean the event never occurred."); expect(within(dialog).queryByLabelText("Event payload")).toBeNull();
  });
  it("keeps the readable record after management withdrawal and configuration500, then clears it on an authoritative owner denial", async () => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history"); fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); const code = await within(dialog).findByLabelText("Event payload"); code.focus();
    view.state.limited = true; view.state.holdContext = true; fireEvent.focus(window); await screen.findByText("Member · Read only"); expect(within(dialog).getByLabelText("Event payload")).toBe(code);
    view.state.holdContext = false; view.state.configuration = "failed"; fireEvent.focus(window); await screen.findByText("configuration_unavailable", { exact: false });
    expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(document.activeElement).toBe(code); expect(document.body).not.toHaveTextContent("private=hidden"); expect(view.writes).toHaveLength(0);
    view.state.ownerDenied = true; fireEvent.focus(window); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.body).not.toHaveTextContent("retained payload"); expect(document.body).not.toHaveTextContent("Retained history");
  });
  it("cancels the rejected redelivery endpoint read when navigation changes and returns", async () => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history");
    const held = barrier<Response>(), original = view.fetch.getMockImplementation()!; let heldSignal: AbortSignal | undefined, hold = true;
    view.fetch.mockImplementation((input, init = {}) => {
      if (hold && (init.method ?? "GET") === "GET" && new URL(input, location.origin).pathname === `/api/v1/teams/${teamId}/webhooks/${endpointId}`) { hold = false; heldSignal = init.signal as AbortSignal; return held.promise; }
      return original(input, init);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ })); view.state.rejectRedelivery = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Register redelivery" })); await waitFor(() => expect(heldSignal).toBeDefined());
    await act(async () => { navigate(webhookUrl({ owner: "team", teamId, endpointId: null, tab: "configuration" })); });
    expect(heldSignal!.aborted).toBe(true);
    await act(async () => { navigate(webhookUrl({ owner: "team", teamId, endpointId, tab: "deliveries", deliveryId })); held.resolve(response({ ...endpoint, name: "Stale endpoint" })); });
    await screen.findByRole("heading", { name: "Shared endpoint", level: 2 }); expect(screen.queryByText("Stale endpoint")).toBeNull();
  });

  it("revalidates a resource-only redelivery403 without erasing still-valid owner management", async () => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ })); view.state.rejectRedelivery = true; view.state.resourceDenied = true; fireEvent.click(within(dialog).getByRole("button", { name: "Register redelivery" }));
    await within(dialog).findByText("You no longer have access to this event. Private event data has been removed.");
    expect(within(dialog).queryByText("Retained history")).toBeNull(); expect(screen.getByText("Admin")).toBeVisible(); expect(screen.getByRole("button", { name: "New webhook" })).toBeEnabled(); expect(screen.getByRole("button", { name: "Edit Shared endpoint" })).toBeEnabled(); expect(view.writes).toHaveLength(1); expect(view.writes[0]!.path).toContain(`/deliveries/${deliveryId}/redeliveries`);
  });
  it("still withdraws management when authoritative configuration reads confirm it after redelivery403", async () => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ })); view.state.rejectRedelivery = true; view.state.limited = true; fireEvent.click(within(dialog).getByRole("button", { name: "Register redelivery" }));
    await screen.findByText("Member · Read only"); await waitFor(() => expect(document.body).not.toHaveTextContent("private=hidden")); expect(within(dialog).getByText("Retained history")).toBeVisible(); expect(screen.getByRole("button", { name: "New webhook" })).toBeDisabled(); expect(within(dialog).getByRole("button", { name: /^Redeliver$/ })).toBeDisabled(); expect(view.writes).toHaveLength(1);
  });
  it.each([false, true])("routes the Delivery dialog's receipt denial through owner-read cleanup after management-only change=%s", async managementChange => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history");
    view.state.loseWrite = true; view.state.receiptMissing = true; fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ })); fireEvent.click(within(dialog).getByRole("button", { name: "Register redelivery" }));
    const check = await within(dialog).findByRole("button", { name: "Check operation" }); await waitFor(() => expect(check).toBeEnabled());
    view.state.holdContext = true; view.state.holdReceipt = true; fireEvent.click(check); await waitFor(() => expect(check).toBeDisabled());
    if (managementChange) { view.state.limited = true; fireEvent.focus(window); await screen.findByText("Member · Read only"); expect(within(dialog).getByText("Retained history")).toBeVisible(); }
    await act(async () => view.releaseReceiptDenial()); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body).not.toHaveTextContent("private=hidden"); expect(view.writes).toHaveLength(1);
    const receipt = [...view.receipts.values()][0]!; const pendingKey = `daynight.webhook.pending:${encodeURIComponent(location.origin)}:${userId}:team:${teamId}`;
    expect(JSON.parse(sessionStorage.getItem(pendingKey)!).operationId).toBe(receipt.operationId); expect(screen.getByText("The operation result is unknown. Check the original request before making another change.")).toBeVisible(); sessionStorage.removeItem(pendingKey);
  });
  it("continues admission against the original Delivery instead of borrowing the newly selected generation", async () => {
    const view = mount(), initial = await screen.findByRole("dialog"); await within(initial).findByText("Retained history");
    fireEvent.click(within(initial).getByRole("button", { name: /^Redeliver$/ })); view.state.holdDigest = true; fireEvent.click(within(initial).getByRole("button", { name: "Register redelivery" }));
    await waitFor(() => expect(view.digestBytes()).not.toBeNull()); fireEvent.click(within(initial).getAllByRole("button", { name: "Close" })[1]!); fireEvent.click(screen.getByRole("button", { name: /Next history/ }));
    const dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Next history"); await act(async () => view.releaseDigest());
    await waitFor(() => expect(view.writes).toHaveLength(1)); expect(view.writes[0]!.path).toContain(`/deliveries/${deliveryId}/redeliveries`); expect(view.writes[0]!.body.ifGeneration).toBe("1"); expect(view.writes[0]!.body.ifVersion).toBe("1"); expect(within(dialog).getByText("Next history")).toBeVisible();
  });
  it("rechecks the original Delivery after a held native digest and sends no POST after authoritative Attempts404", async () => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Redeliver$/ })); view.state.holdDigest = true; fireEvent.click(within(dialog).getByRole("button", { name: "Register redelivery" }));
    await waitFor(() => expect(view.digestBytes()).not.toBeNull()); view.state.missing = true; view.state.holdContext = true; fireEvent.focus(window);
    await within(dialog).findByText("This history has expired; its absence does not mean the event never occurred.");
    await act(async () => view.releaseDigest()); await waitFor(() => expect(screen.getByRole("button", { name: "New webhook" })).toBeEnabled()); expect(view.writes).toHaveLength(0);
  });
});
