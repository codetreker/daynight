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

const mount = () => {
  mockSidebarMediaQuery();
  const lifetime = new AbortController(), admission = { userId, signal: lifetime.signal, ready: async (signal: AbortSignal) => signal.throwIfAborted(), isInvalidated: false, principalMismatch: vi.fn() } as unknown as TaskCacheScope;
  const state = { limited: false, missing: false, holdContext: false, holdDigest: false }, context = barrier<Response>(), heldDetail = barrier<Response>(), heldDigest = barrier<ArrayBuffer>();
  let digestBytes: Uint8Array<ArrayBuffer> | null = null;
  vi.stubGlobal("crypto", { randomUUID, subtle: { digest: (algorithm: string, bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> => { if (state.holdDigest) { digestBytes = bytes.slice(); return heldDigest.promise; } return webcrypto.subtle.digest(algorithm, bytes); } } });
  const writes: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
  let currentDelivery = delivery;
  const payloadText = "retained payload", raw = Buffer.from(payloadText), base = `/api/v1/teams/${teamId}/webhooks`;
  const fetch = vi.fn((input: string, init: RequestInit = {}) => {
    const url = new URL(input, location.origin), path = url.pathname;
    if ((init.method ?? "GET") !== "GET") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push({ path, body });
      if (state.missing) return Promise.resolve(failure());
      const operation: WebhookReceipt = { operationId: String(body.operationId), kind: "delivery.redeliver", issuedAt: String(body.issuedAt), requestSha256: createHash("sha256").update(String(init.body)).digest("hex"), actorUserId: userId, owner, endpointId, effect: "applied", configVersionAfter: "1", destinationRevisionAfter: "1", deliveryId, generationAfter: "2", keyId: null, overlapUntil: null, recordedAt: happened, expiresAt: expires };
      currentDelivery = { ...delivery, generation: "2", manualOperationCount: 1, state: "pending", nextAttemptAt: new Date().toISOString() };
      return Promise.resolve(response({ operation, delivery: currentDelivery }, 202));
    }
    if (state.holdContext && ["/api/v1/teams", base, `${base}/${endpointId}`].includes(path)) return context.promise;
    if (path === "/api/v1/teams") return Promise.resolve(response({ items: [{ id: teamId, kind: "ordinary", name: "Engineering", version: 1, createdAt: happened, updatedAt: happened, membership: { teamId, userId, role: "admin", version: 1, createdAt: happened, updatedAt: happened } }], nextCursor: null }));
    if (path === "/api/v1/projects") return Promise.resolve(response({ items: [], nextCursor: null }));
    if (path === base) return Promise.resolve(response({ items: [{ id: endpointId, owner, name: endpoint.name, enabled: true, configVersion: "1", destination: endpoint.destination, projectCount: 0, eventTypeCount: 0, lastAttemptAt: happened, lastResult: null }], nextCursor: null }));
    if (path === `${base}/${endpointId}`) return Promise.resolve(response(endpoint));
    if (path.endsWith("/attempts")) return Promise.resolve(state.missing ? failure() : response(page([])));
    if (path.endsWith("/payload")) { const isNext = path.includes(nextDelivery.id); return Promise.resolve(response({ owner, endpointId, deliveryId: isNext ? nextDelivery.id : deliveryId, eventId: isNext ? nextDelivery.eventId : eventId, mediaType: "application/cloudevents+json", encoding: "base64", body: raw.toString("base64"), bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") })); }
    if (path.endsWith("/deliveries")) return Promise.resolve(response(page(state.missing ? [] : [state.limited ? { ...currentDelivery, target: { ...currentDelivery.target, url: null, displayUrl: "https://receiver.example/…" } } : currentDelivery, nextDelivery])));
    if (path.endsWith(`/deliveries/${nextDelivery.id}`)) return Promise.resolve(response(nextDelivery));
    if (path.endsWith(`/deliveries/${deliveryId}`)) return state.missing ? heldDetail.promise : Promise.resolve(response(state.limited ? { ...currentDelivery, target: { ...currentDelivery.target, url: null, displayUrl: "https://receiver.example/…" } } : currentDelivery));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  const route = { kind: "webhooks" as const, owner: "team" as const, teamId, endpointId, tab: "deliveries" as const, deliveryId, error: null };
  act(() => navigate(webhookUrl(route)));
  const View = () => { const navigation = browserNavigation(), location = useSyncExternalStore(navigation.subscribe, navigation.snapshot), current = parseAuthRoute(location.pathname, location.search); return current.kind === "webhooks" ? <WebhooksPage user={user} admission={admission} active route={current} catalog={catalog}/> : null; };
  const rendered = renderWithLocale(<View/>, { locale: "en" });
  return { ...rendered, state, writes, fetch, digestBytes: () => digestBytes, releaseDigest: async () => { state.holdDigest = false; heldDigest.resolve(await webcrypto.subtle.digest("SHA-256", digestBytes!)); } };
};


describe("webhook delivery admission in the complete page", () => {
  it("withdraws owner management without withdrawing readable resource payload when a Delivery target is restricted", async () => {
    const view = mount(), dialog = await screen.findByRole("dialog"); await within(dialog).findByText("Retained history");
    fireEvent.click(within(dialog).getByRole("button", { name: "View payload" })); const code = await within(dialog).findByLabelText("Event payload");
    view.state.limited = true; view.state.holdContext = true; fireEvent.focus(window);
    await waitFor(() => expect(document.body).not.toHaveTextContent("private=hidden"));
    expect(screen.getByText("Member · Read only")).toBeVisible(); expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("Event payload")).toBe(code); expect(within(dialog).getByText("Retained history")).toBeVisible(); expect(view.writes).toHaveLength(0);
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
