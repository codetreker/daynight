import { createHash, randomUUID, webcrypto } from "node:crypto";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../src/api/auth-types";
import { parseWebhookCatalog, type WebhookActiveEndpoint, type WebhookEndpoint, type WebhookReceipt } from "../src/api/webhooks";
import { browserNavigation } from "../src/app/navigation";
import { navigate, parseAuthRoute } from "../src/app/router";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { WebhooksPage } from "../src/features/webhooks/WebhooksPage";
import { renderWithLocale } from "./helpers/renderWithLocale";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1), teamId = id(2), projectId = id(3), secondProjectId = id(4), endpointId = id(5), keyId = id(6), now = "2026-11-08T00:00:00Z";
const user: CurrentUser = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: id(10), kind: "personal", name: null } };
const catalog = parseWebhookCatalog({ items: ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: "project" })), service: { configurationExpansionAvailable: true, dispatchEnabled: false }, limits: { policyVersion: "1", requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 } });
const endpoint = (n = 5): WebhookActiveEndpoint => ({ id: id(n), owner: { kind: "personal", id: userId }, lifecycle: "active", configVersion: "1", deletedAt: null, name: `Endpoint ${n}`, enabled: true, destinationRevision: "1", destination: { kind: "http", adapterVersion: "1", url: "https://receiver.example/hooks?private=hidden", displayUrl: "https://receiver.example/hooks?private=hidden" }, signing: { scheme: "standard-webhooks-v1", activeKeyId: keyId, overlapUntil: null }, subscriptions: [{ id: id(7), projectId, projectName: "Project one", eventTypes: ["task.paused", "task.created"], eligibility: "eligible" }], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const failure = (status: number, code: string) => response({ error: { code, message: "Request failed.", requestId: "test-request" } }, status);
const flush = () => act(async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); });
const barrier = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

const mount = async ({ strict = false, initial = [endpoint()], expand = true }: { readonly strict?: boolean; readonly initial?: readonly WebhookActiveEndpoint[]; readonly expand?: boolean } = {}) => {
  vi.stubGlobal("crypto", { subtle: webcrypto.subtle, randomUUID });
  const lifetime = new AbortController();
  const admission = { userId, signal: lifetime.signal, ready: async (signal: AbortSignal) => signal.throwIfAborted(), isInvalidated: false, principalMismatch: vi.fn() } as unknown as TaskCacheScope;
  const resources = new Map<string, WebhookEndpoint>(initial.map(value => [value.id, value])), receipts = new Map<string, WebhookReceipt>(), writes: { readonly method: string; readonly body: Record<string, unknown> }[] = [];
  let next = 50, secretReads = 0, active = true, loseWrite = false, holdWrite = false, writeResponse: Response | null = null;
  const writeBarrier = barrier<Response>();
  let intercept: ((url: string, init: RequestInit) => Promise<Response> | null) | null = null;
  const fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const held = intercept?.(url, init); if (held !== null && held !== undefined) return held;
    const target = new URL(url, location.origin), method = init.method ?? "GET";
    if (target.pathname === "/api/v1/teams") return Promise.resolve(response({ items: [{ id: teamId, kind: "ordinary", name: "Engineering", version: 1, createdAt: now, updatedAt: now, membership: { teamId, userId, role: "admin", version: 1, createdAt: now, updatedAt: now } }], nextCursor: null }));
    if (target.pathname === "/api/v1/projects") return Promise.resolve(response({ items: [projectId, secondProjectId].map((project, index) => ({ id: project, name: index === 0 ? "Project one" : "Project two", ownership: { teamId, version: 1 }, repoUrl: "https://example.test/repo.git", settings: { version: 1, executionWarningMinutes: 60 }, createdAt: now, updatedAt: now })), nextCursor: null }));
    const operation = /\/operations\/([^/]+)$/.exec(target.pathname);
    if (operation !== null) return Promise.resolve(receipts.has(operation[1]!) ? response(receipts.get(operation[1]!)) : failure(404, "not_found"));
    const owner = target.pathname.includes("/teams/") ? { kind: "team" as const, id: teamId } : { kind: "personal" as const, id: userId };
    const resourceId = /\/webhooks\/([^/]+)/.exec(target.pathname)?.[1] ?? null;
    if (target.pathname.endsWith("/signing-secret")) { secretReads++; const resource = resources.get(resourceId!) as WebhookActiveEndpoint; return Promise.resolve(response({ endpointId: resource.id, configVersion: resource.configVersion, keyId: resource.signing.activeKeyId, scheme: "standard-webhooks-v1", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` })); }
    if (method === "GET") {
      if (resourceId !== null) return Promise.resolve(resources.has(resourceId) ? response(resources.get(resourceId)) : failure(404, "not_found"));
      const q = target.searchParams.get("q") ?? "", enabled = target.searchParams.get("enabled");
      const values = [...resources.values()].filter((value): value is WebhookActiveEndpoint => value.lifecycle === "active" && value.owner.kind === owner.kind && value.owner.id === owner.id && (value.name.includes(q) || value.destination.displayUrl.includes(q)) && (enabled === null || String(value.enabled) === enabled));
      const start = Number(target.searchParams.get("cursor") ?? 0), items = values.slice(start, start + 2).map(value => ({ id: value.id, owner: value.owner, name: value.name, enabled: value.enabled, configVersion: value.configVersion, destination: value.destination, projectCount: new Set(value.subscriptions.map(sub => sub.projectId)).size, eventTypeCount: new Set(value.subscriptions.flatMap(sub => sub.eventTypes)).size, lastAttemptAt: null, lastResult: null }));
      return Promise.resolve(response({ items, nextCursor: start + 2 < values.length ? String(start + 2) : null }));
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>; writes.push({ method, body });
    let current: WebhookEndpoint, originalRevision = "1";
    const creating = resourceId === null, rotating = target.pathname.endsWith("/rotations");
    if (creating) {
      const base = endpoint(next++); current = { ...base, owner, name: body.name as string, destination: { ...base.destination, url: (body.destination as { configuration: { url: string } }).configuration.url, displayUrl: (body.destination as { configuration: { url: string } }).configuration.url }, subscriptions: (body.subscriptions as { projectId: string; eventTypes: WebhookActiveEndpoint["subscriptions"][number]["eventTypes"] }[]).map(sub => ({ id: id(next++), projectId: sub.projectId, projectName: sub.projectId === projectId ? "Project one" : "Project two", eventTypes: sub.eventTypes, eligibility: "eligible" })) };
    } else {
      const original = resources.get(resourceId!) as WebhookActiveEndpoint; originalRevision = original.destinationRevision;
      if (body.ifVersion !== original.configVersion) return Promise.resolve(failure(409, "version_conflict"));
      const version = String(BigInt(original.configVersion) + 1n);
      if (method === "DELETE") current = { id: original.id, owner, lifecycle: "deleted", configVersion: version, deletedAt: now };
      else if (rotating) current = { ...original, configVersion: version, signing: { ...original.signing, activeKeyId: id(next++), overlapUntil: body.mode === "overlap" ? "2026-11-09T00:00:00Z" : null } };
      else current = { ...original, configVersion: version, ...(Object.hasOwn(body, "name") ? { name: body.name as string } : {}), ...(Object.hasOwn(body, "enabled") ? { enabled: body.enabled as boolean } : {}), ...(Object.hasOwn(body, "destination") ? { destinationRevision: String(BigInt(original.destinationRevision) + 1n), destination: { ...original.destination, url: (body.destination as { configuration: { url: string } }).configuration.url, displayUrl: (body.destination as { configuration: { url: string } }).configuration.url } } : {}), ...(Object.hasOwn(body, "subscriptions") ? { subscriptions: (body.subscriptions as WebhookActiveEndpoint["subscriptions"]).map(sub => ({ ...sub, id: sub.id ?? id(next++), projectName: sub.projectId === projectId ? "Project one" : "Project two", eligibility: "eligible" })) } : {}) };
    }
    resources.set(current.id, current);
    const receipt: WebhookReceipt = { operationId: body.operationId as string, kind: creating ? "endpoint.create" : rotating ? "signing-secret.rotate" : method === "DELETE" ? "endpoint.delete" : "endpoint.patch", issuedAt: body.issuedAt as string, requestSha256: createHash("sha256").update(String(init.body)).digest("hex"), actorUserId: userId, owner, endpointId: current.id, effect: "applied", configVersionAfter: current.configVersion, destinationRevisionAfter: current.lifecycle === "active" ? current.destinationRevision : originalRevision, deliveryId: null, generationAfter: null, keyId: rotating && current.lifecycle === "active" ? current.signing.activeKeyId : null, overlapUntil: rotating && current.lifecycle === "active" ? current.signing.overlapUntil : null, recordedAt: now, expiresAt: "2026-12-08T00:00:00Z" };
    receipts.set(receipt.operationId, receipt);
    if (loseWrite) { loseWrite = false; return Promise.reject(new Error("connection lost after commit")); }
    const result = response(rotating && current.lifecycle === "active" ? { operation: receipt, signing: { activeKeyId: current.signing.activeKeyId, overlapUntil: current.signing.overlapUntil } } : { operation: receipt, endpoint: current }, creating ? 201 : 200);
    if (holdWrite) { writeResponse = result; return writeBarrier.promise; }
    return Promise.resolve(result);
  });
  vi.stubGlobal("fetch", fetch);
  act(() => navigate("/webhooks?owner=personal"));
  const View = () => { const navigation = browserNavigation(), location = useSyncExternalStore(navigation.subscribe, navigation.snapshot), route = parseAuthRoute(location.pathname, location.search); return route.kind === "webhooks" ? <WebhooksPage user={user} admission={admission} active={active} route={route} catalog={{ ...catalog, service: { ...catalog.service, configurationExpansionAvailable: expand } }}/> : null; };
  const content = () => strict ? <StrictMode><View/></StrictMode> : <View/>;
  const rendered = renderWithLocale(content(), { locale: "en" }); await flush();
  return { ...rendered, fetch, writes, resources, receipts, admission, loseNextWrite: () => { loseWrite = true; }, holdNextWrite: () => { holdWrite = true; }, releaseWrite: () => { holdWrite = false; writeBarrier.resolve(writeResponse!); }, secretReads: () => secretReads, intercept: (value: typeof intercept) => { intercept = value; }, pause: () => { active = false; rendered.rerender(content()); }, resume: () => { active = true; rendered.rerender(content()); } };
};
const openEdit = () => fireEvent.click(screen.getByRole("button", { name: "Edit Endpoint 5" }));
const setName = (name: string) => { const input = screen.getByRole("textbox", { name: /^Name$/ }); fireEvent.change(input, { target: { value: name } }); return input as HTMLInputElement; };
const submitForm = () => fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

describe("Webhook configuration page", () => {
  it("loads the real nullable summary shape and requires an explicit team selection", async () => {
    const view = await mount(); expect(screen.getByText("No deliveries yet")).toBeVisible(); expect(view.secretReads()).toBe(0);
    const personalReads = view.fetch.mock.calls.filter(([path]) => String(path).startsWith("/api/v1/me/webhooks")).length;
    fireEvent.click(screen.getByRole("button", { name: "Team shared" })); await flush();
    expect(screen.getByRole("combobox", { name: "Choose a team" })).toHaveValue("");
    expect(view.fetch.mock.calls.filter(([path]) => String(path).startsWith("/api/v1/me/webhooks"))).toHaveLength(personalReads);
    expect(view.fetch.mock.calls.some(([path]) => String(path).startsWith(`/api/v1/teams/${teamId}/webhooks`))).toBe(false);
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a team" }), { target: { value: teamId } }); await flush();
    expect(view.fetch.mock.calls.some(([path]) => String(path).startsWith(`/api/v1/teams/${teamId}/webhooks`))).toBe(true);
  });

  it("keeps the native editor, draft, selection and loaded pages during unchanged background checks", async () => {
    const view = await mount({ strict: true, initial: [endpoint(), endpoint(8), endpoint(9)] });
    fireEvent.click(screen.getByRole("button", { name: "Load more" })); await flush();
    expect(document.querySelectorAll(".endpoint-row")).toHaveLength(3);
    openEdit(); const input = setName("Draft name"); input.focus(); input.setSelectionRange(2, 5);
    const dialog = screen.getByRole("dialog"), held = barrier<Response>();
    view.intercept((url, init) => url.startsWith("/api/v1/me/webhooks?") && init.method === undefined ? held.promise : null);
    fireEvent.focus(window); await flush(); expect(screen.getByRole("dialog")).toBe(dialog); expect(input).toHaveFocus(); expect(input.selectionStart).toBe(2); expect(document.querySelectorAll(".endpoint-row")).toHaveLength(3);
    view.intercept(null); held.resolve(response({ items: [endpoint(), endpoint(8)].map(value => ({ id: value.id, owner: value.owner, name: value.name, enabled: true, configVersion: value.configVersion, destination: value.destination, projectCount: 1, eventTypeCount: 2, lastAttemptAt: null, lastResult: null })), nextCursor: "2" })); await flush();
    expect(document.querySelectorAll(".endpoint-row")).toHaveLength(3); expect(screen.getByRole("dialog")).toBe(dialog); expect(input).toHaveValue("Draft name"); expect(input.selectionEnd).toBe(5);
    view.pause(); expect(input.isConnected).toBe(true); expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); view.resume(); await flush(); expect(input).toHaveValue("Draft name");
  });

  it("captures the exact large version and preserves the draft after a conflict until a new decision", async () => {
    const original = { ...endpoint(), configVersion: "9007199254740993" }; const view = await mount({ initial: [original] });
    openEdit(); setName("Changed"); view.resources.set(endpointId, { ...original, configVersion: "9007199254740994", name: "Other change" }); submitForm(); await waitFor(() => expect(view.writes.length).toBeGreaterThan(0)); await flush();
    expect(view.writes).toHaveLength(1); expect(view.writes[0]!.body.ifVersion).toBe("9007199254740993"); expect(screen.getByRole("textbox", { name: /^Name$/ })).toHaveValue("Changed"); expect(screen.getByRole("alert")).toHaveTextContent("configuration changed");
    fireEvent.click(screen.getByRole("button", { name: "Review current version" })); await flush(); submitForm(); await waitFor(() => expect(view.writes.length).toBeGreaterThan(0)); await flush();
    expect(view.writes).toHaveLength(2); expect(view.writes[1]!.body.ifVersion).toBe("9007199254740994"); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses one fixed create intent for Enter/button duplicates and keeps empty explicit subscriptions", async () => {
    const view = await mount({ initial: [] }); fireEvent.click(screen.getAllByRole("button", { name: "New webhook" })[0]!); setName("Created"); fireEvent.change(screen.getByRole("textbox", { name: /Endpoint URL/ }), { target: { value: "https://receiver.example/new" } });
    submitForm(); submitForm(); await waitFor(() => expect(view.writes.length).toBeGreaterThan(0)); await flush(); expect(view.writes).toHaveLength(1); expect(view.writes[0]!.body.subscriptions).toEqual([]); expect(view.writes[0]!.body.expectedUserId).toBe(userId); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("replaces a changed subscription project with id:null in one complete CAS array", async () => {
    const view = await mount(); fireEvent.click(screen.getByRole("tab", { name: /Subscriptions/ })); await flush(); fireEvent.click(screen.getByRole("button", { name: "Edit subscription Project one" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: secondProjectId } }); submitForm(); await waitFor(() => expect(view.writes.length).toBeGreaterThan(0)); await flush();
    expect(view.writes).toHaveLength(1); expect(view.writes[0]!.body.subscriptions).toEqual([{ id: null, projectId: secondProjectId, eventTypes: ["task.paused", "task.created"] }]);
  });

  it("scrubs same-version revoked URL and secret plus a retained editor after current permission confirmation", async () => {
    const view = await mount(); fireEvent.click(screen.getByRole("button", { name: "Show secret" })); await flush(); expect(screen.getByText(/^whsec_[A-Za-z]/)).toBeVisible(); openEdit(); setName("Sensitive draft");
    const original = endpoint(); view.resources.set(endpointId, { ...original, destination: { ...original.destination, url: null, displayUrl: "https://receiver.example/…" }, capabilities: { manage: false, readSecret: false, redeliver: false } });
    fireEvent.focus(window); await flush(); expect(screen.queryByRole("dialog")).toBeNull(); expect(document.body.textContent).not.toContain("private=hidden"); expect(document.body.textContent).not.toMatch(/whsec_[A-Za-z]/); expect(screen.getByRole("button", { name: "Show secret" })).toBeDisabled();
  });

  it("keeps failed search data without claiming that it is the new complete search", async () => {
    const view = await mount(); view.intercept((url) => url.includes("q=missing") ? Promise.resolve(failure(503, "database_unavailable")) : null);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search name or URL" }), { target: { value: "missing" } }); await flush();
    expect(document.querySelectorAll(".endpoint-row")).toHaveLength(1); expect(screen.getByText("Showing the previous search while the new search is checked")).toBeVisible(); expect(screen.queryByText("No matching Webhooks")).toBeNull(); expect(screen.getByRole("alert")).toBeVisible();
  });

  it("performs restrictive cleanup while expansion is unavailable", async () => {
    const view = await mount({ expand: false }); expect(screen.getByRole("button", { name: "New webhook" })).toBeDisabled(); fireEvent.click(screen.getByRole("switch", { name: "Enable delivery" })); await flush();
    expect(view.writes[0]!.body.enabled).toBe(false); expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false"); expect(screen.getByRole("switch")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" })); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete webhook" })); await flush(); expect(view.writes[1]!.method).toBe("DELETE"); expect(document.body.textContent).not.toContain("private=hidden");
  });

  it("reads secrets only on request and preserves original rotation identity without reading the new secret", async () => {
    const view = await mount(); fireEvent.click(screen.getByRole("button", { name: "Show secret" })); await flush(); expect(view.secretReads()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Rotate secret" })); expect(document.body.textContent).not.toMatch(/whsec_[A-Za-z]/); fireEvent.click(screen.getByRole("button", { name: "Generate new secret" })); await waitFor(() => expect(screen.getByText("Original rotation key")).toBeVisible()); expect(view.writes[0]!.body.mode).toBe("overlap"); expect(view.secretReads()).toBe(1); expect(screen.getByText("Original rotation key")).toBeVisible();
  });

  it("keeps unknown writes fixed and exposes GET-only recovery inside the native editor", async () => {
    const view = await mount(); openEdit(); setName("Unknown write"); view.loseNextWrite();
    view.intercept(url => url.includes("/operations/") ? Promise.resolve(failure(404, "not_found")) : null);
    submitForm(); await waitFor(() => expect(view.writes).toHaveLength(1)); await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("operation result is unknown"));
    const dialog = screen.getByRole("dialog"); expect(dialog).toHaveTextContent("operation result is unknown"); expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    const keys = Object.keys(sessionStorage).filter(key => key.startsWith("daynight.webhook.pending:")); expect(keys).toHaveLength(1);
    const metadata = sessionStorage.getItem(keys[0]!)!; expect(metadata).not.toContain("private=hidden"); expect(metadata).not.toContain("Unknown write");
    view.intercept(null); fireEvent.click(within(dialog).getByRole("button", { name: "Check operation" })); await flush();
    expect(view.writes).toHaveLength(1); expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByText("Original operation confirmed")).toBeVisible();
  });

  it("does not let a delayed row action replace a newer endpoint selection", async () => {
    const view = await mount({ initial: [endpoint(), endpoint(8)] });
    const held = barrier<Response>(); view.intercept((url, init) => url === `/api/v1/me/webhooks/${endpointId}` && (init.method === undefined || init.method === "GET") ? held.promise : null);
    fireEvent.click(screen.getByRole("button", { name: "More actions Endpoint 5" }));
    fireEvent.click(within(document.querySelector(".row-menu")! as HTMLElement).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Endpoint 8" }));
    await screen.findByRole("heading", { name: "Endpoint 8", level: 2 });
    held.resolve(response(endpoint())); await flush();
    expect(new URLSearchParams(location.search).get("endpointId")).toBe(id(8));
    expect(screen.getByRole("heading", { name: "Endpoint 8", level: 2 })).toBeVisible(); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not let a held admin row read restore same-version data after a newer member projection", async () => {
    const original = { ...endpoint(), owner: { kind: "team" as const, id: teamId } };
    const view = await mount({ initial: [original] }); fireEvent.click(screen.getByRole("button", { name: "Team shared" })); await flush();
    fireEvent.change(screen.getByRole("combobox", { name: "Choose a team" }), { target: { value: teamId } }); await screen.findByRole("heading", { name: "Endpoint 5", level: 2 }); fireEvent.click(screen.getByRole("button", { name: "Endpoint 5" })); await flush();
    const held = barrier<Response>(); let first = true;
    view.intercept((url, init) => { if (first && url === `/api/v1/teams/${teamId}/webhooks/${endpointId}` && (init.method === undefined || init.method === "GET")) { first = false; return held.promise; } return null; });
    fireEvent.click(screen.getByRole("button", { name: "More actions Endpoint 5" })); fireEvent.click(within(document.querySelector(".row-menu")! as HTMLElement).getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(first).toBe(false));
    view.resources.set(endpointId, { ...original, destination: { ...original.destination, url: null, displayUrl: "https://receiver.example/…" }, capabilities: { manage: false, readSecret: false, redeliver: false } });
    fireEvent.focus(window); await waitFor(() => expect(document.body.textContent).not.toContain("private=hidden"));
    held.resolve(response(original)); await flush(); expect(document.body.textContent).not.toContain("private=hidden"); expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByRole("button", { name: "Edit Endpoint 5" })).toBeDisabled();
  });

  it("confirms a delayed write receipt while refusing its stale privileged current projection", async () => {
    const view = await mount(); openEdit(); setName("Committed name"); view.holdNextWrite(); submitForm();
    await waitFor(() => expect(view.writes).toHaveLength(1)); const committed = view.resources.get(endpointId) as WebhookActiveEndpoint;
    view.resources.set(endpointId, { ...committed, destination: { ...committed.destination, url: null, displayUrl: "https://receiver.example/…" }, capabilities: { manage: false, readSecret: false, redeliver: false } });
    fireEvent.focus(window); await waitFor(() => expect(document.body.textContent).not.toContain("private=hidden"));
    view.releaseWrite(); await screen.findByText("Original operation confirmed"); await flush();
    expect(document.body.textContent).not.toContain("private=hidden"); expect(screen.getByRole("button", { name: "Edit Committed name" })).toBeDisabled(); expect(view.writes).toHaveLength(1);
  });

  it("withdraws deleted private data as soon as the receipt is confirmed and consumes the final tombstone while background reads wait", async () => {
    const view = await mount(); fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const held = barrier<Response>(); view.intercept((url, init) => url.includes("/webhooks") && (init.method === undefined || init.method === "GET") ? held.promise : null);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete webhook" }));
    await waitFor(() => expect(view.writes).toHaveLength(1)); await waitFor(() => expect(screen.getByText("Original operation confirmed")).toBeVisible());
    expect(document.body.textContent).not.toContain("private=hidden"); expect(document.body.textContent).not.toContain("Endpoint 5");
    await waitFor(() => expect(screen.getByText("This Webhook has been deleted.")).toBeVisible());
  });

  it("rejects duplicate cursor pages while keeping the previously validated list", async () => {
    const view = await mount({ initial: [endpoint(), endpoint(8), endpoint(9)] });
    const first = endpoint(); view.intercept(url => url.includes("cursor=2") ? Promise.resolve(response({ items: [{ id: first.id, owner: first.owner, name: first.name, enabled: true, configVersion: first.configVersion, destination: first.destination, projectCount: 1, eventTypeCount: 2, lastAttemptAt: null, lastResult: null }], nextCursor: "2" })) : null);
    fireEvent.click(screen.getByRole("button", { name: "Load more" })); await flush(); expect(document.querySelectorAll(".endpoint-row")).toHaveLength(2); expect(screen.getByRole("alert")).toHaveTextContent("invalid response");
  });

  it.each(["Edit", "Delete"] as const)("restores the connected row trigger after Escape from a menu %s dialog", async action => {
    await mount(); const trigger = screen.getByRole("button", { name: "More actions Endpoint 5" }); trigger.focus(); fireEvent.click(trigger);
    fireEvent.click(within(document.querySelector(".row-menu")! as HTMLElement).getByRole("button", { name: action }));
    const dialog = await screen.findByRole("dialog"); fireEvent(dialog, new Event("cancel", { cancelable: true })); expect(screen.queryByRole("dialog")).toBeNull(); await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("focuses the page creation control after its deleted row opener is removed", async () => {
    const view = await mount(); fireEvent.click(screen.getByRole("button", { name: "More actions Endpoint 5" })); fireEvent.click(within(document.querySelector(".row-menu")! as HTMLElement).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog"); fireEvent.click(within(dialog).getByRole("button", { name: "Delete webhook" }));
    await waitFor(() => expect(view.writes).toHaveLength(1)); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "New webhook" })[0]!).toHaveFocus());
  });

  it("translates retained drafts and restores the opener after native cancel", async () => {
    const view = await mount(); const opener = screen.getByRole("button", { name: "Edit Endpoint 5" }); opener.focus(); fireEvent.click(opener); const input = setName("Draft"); view.setLocale("zh-CN"); expect(input).toHaveValue("Draft"); expect(screen.getByRole("dialog")).toHaveAccessibleName("编辑 Webhook"); fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true })); expect(screen.queryByRole("dialog")).toBeNull(); await waitFor(() => expect(opener).toHaveFocus());
  });
});
