import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { navigate } from "../src/app/router";
import { renderWithLocale } from "./helpers/renderWithLocale";
import { personalTeamPage } from "./helpers/team";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(101), otherUserId = id(102), endpointId = id(103), operationId = id(104), keyId = id(105), now = "2026-11-08T00:00:00Z";
const user = (actor = userId) => ({ id: actor, name: actor === userId ? "Alice" : "Bob", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: id(701), kind: "personal", name: null } });
const destination = { kind: "http", adapterVersion: "1", url: "https://receiver.example/private?authorization=private-marker", displayUrl: "https://receiver.example/private?authorization=private-marker" };
const catalog = { items: ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: "project" })), service: { configurationExpansionAvailable: true, dispatchEnabled: false }, limits: { policyVersion: "1", requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 } };
const endpoint = { id: endpointId, owner: { kind: "personal", id: userId }, lifecycle: "active", configVersion: "1", deletedAt: null, name: "Private endpoint", enabled: true, destinationRevision: "1", destination, signing: { scheme: "standard-webhooks-v1", activeKeyId: keyId, overlapUntil: null }, subscriptions: [], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now };
const response = (data: unknown, actor: string | null = userId, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...(actor === null ? {} : { "Daynight-User-ID": actor }) } });

describe("Webhook private-state cleanup in the authenticated application", () => {
  it.each(["signout", "401", "principal mismatch"] as const)("revokes the old view after %s even when storage enumeration fails, then retries cleanup", async trigger => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    let actor = userId, denyStorage = false, privateFailure = false;
    const originalLength = Object.getOwnPropertyDescriptor(Storage.prototype, "length")!.get!;
    vi.spyOn(Storage.prototype, "length", "get").mockImplementation(function (this: Storage) {
      if (this === window.sessionStorage && denyStorage) throw new DOMException("Storage enumeration denied", "SecurityError");
      return originalLength.call(this);
    });
    const fetch = vi.fn((url: string, init: RequestInit = {}) => {
      if (url === "/api/v1/me") return Promise.resolve(response(user(actor), actor));
      if (url === "/api/v1/auth/providers") return Promise.resolve(response({ providers: ["github"] }, actor));
      if (url === "/api/v1/auth/logout") return Promise.resolve(new Response(null, { status: 204 }));
      if (url.startsWith("/api/v1/teams?")) return Promise.resolve(response(personalTeamPage(actor), actor));
      if (url.startsWith("/api/v1/projects")) return Promise.resolve(response({ items: [], nextCursor: null }, actor));
      if (url === "/api/v1/webhook-event-types") return Promise.resolve(response(catalog, actor));
      if (url.startsWith("/api/v1/me/webhooks")) {
        if (privateFailure && trigger === "401") return Promise.resolve(response({ error: { code: "unauthenticated", message: "Expired", requestId: "cleanup-test" } }, null, 401));
        if (privateFailure && trigger === "principal mismatch") { privateFailure = false; actor = otherUserId; return Promise.resolve(response({ items: [], nextCursor: null }, actor)); }
        if (url === `/api/v1/me/webhooks/${endpointId}`) return Promise.resolve(response(endpoint, actor));
        return Promise.resolve(response({ items: actor !== userId ? [] : [{ id: endpointId, owner: endpoint.owner, name: endpoint.name, enabled: true, configVersion: "1", destination, projectCount: 0, eventTypeCount: 0, lastAttemptAt: null, lastResult: null }], nextCursor: null }, actor));
      }
      throw new Error(`Unexpected test request: ${init.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    act(() => navigate("/webhooks?owner=personal"));
    renderWithLocale(<AuthenticatedApp/>, { locale: "en" });
    await screen.findByRole("heading", { name: "Private endpoint", level: 2 });
    const pendingKey = `daynight.webhook.pending:${encodeURIComponent(location.origin)}:${userId}:personal:${userId}`;
    sessionStorage.setItem(pendingKey, JSON.stringify({ serviceOrigin: location.origin, actorUserId: userId, owner: endpoint.owner, operationId, issuedAt: now, requestSha256: "a".repeat(64), kind: "endpoint.patch", endpointId, deliveryId: null, ifVersion: "1", ifGeneration: null, destinationRevision: "1" }));
    denyStorage = true;
    if (trigger === "signout") {
      fireEvent.click(screen.getByRole("button", { name: "Account menu: Alice" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    } else { privateFailure = true; fireEvent.click(screen.getByRole("button", { name: "Refresh" })); }
    await screen.findByText("Local recovery records could not be cleared.");
    await waitFor(() => expect(document.body.textContent).not.toContain("authorization=private-marker"));
    expect(screen.queryByRole("heading", { name: "Private endpoint" })).toBeNull();
    expect(sessionStorage.getItem(pendingKey)).not.toBeNull();
    if (trigger === "principal mismatch") await screen.findByRole("button", { name: "Account menu: Bob" });
    expect(fetch.mock.calls.filter(([url, init]) => url.includes("webhooks") && init?.method !== undefined && init.method !== "GET")).toHaveLength(0);
    denyStorage = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() => expect(screen.queryByText("Local recovery records could not be cleared.")).toBeNull());
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });
});
