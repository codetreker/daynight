import { createHash, randomUUID, webcrypto } from "node:crypto";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../src/api/auth-types";
import { parseWebhookCatalog, type WebhookActiveEndpoint } from "../src/api/webhooks";
import { browserNavigation } from "../src/app/navigation";
import { navigate, parseAuthRoute } from "../src/app/router";
import type { TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { WebhooksPage } from "../src/features/webhooks/WebhooksPage";
import { mockSidebarMediaQuery } from "./helpers/mediaQuery";
import { renderWithLocale } from "./helpers/renderWithLocale";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1), teamId = id(2), movedProject = id(3), eligibleProject = id(4), endpointId = id(5), keyId = id(6), now = "2026-11-08T00:00:00Z";
const owner = { kind: "team" as const, id: teamId }, base = `/api/v1/teams/${teamId}/webhooks`;
const user: CurrentUser = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: id(10), kind: "personal", name: null } };
const catalog = parseWebhookCatalog({ items: ["task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: "project" })), service: { configurationExpansionAvailable: true, dispatchEnabled: false }, limits: { policyVersion: "1", requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 } });
const endpoint: WebhookActiveEndpoint = { id: endpointId, owner, lifecycle: "active", configVersion: "1", deletedAt: null, name: "Existing endpoint", enabled: true, destinationRevision: "1", destination: { kind: "http", adapterVersion: "1", url: "https://receiver.example/hooks?private=synthetic", displayUrl: "https://receiver.example/hooks?private=synthetic" }, signing: { scheme: "standard-webhooks-v1", activeKeyId: keyId, overlapUntil: null }, subscriptions: [], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Daynight-User-ID": userId } });
const refusal = (code: string) => response({ error: { code, message: "Forbidden", requestId: "project-refusal" } }, 403);
const barrier = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

const mount = async (tab: "configuration" | "subscriptions") => {
  mockSidebarMediaQuery();
  vi.stubGlobal("crypto", { subtle: webcrypto.subtle, randomUUID });
  const lifetime = new AbortController();
  const admission = { userId, signal: lifetime.signal, ready: async (signal: AbortSignal) => signal.throwIfAborted(), isInvalidated: false, principalMismatch: vi.fn() } as unknown as TaskCacheScope;
  const denied = barrier<Response>(), directory = barrier<Response>(), initialDetail = barrier<Response>();
  let holdInitialDetail = true;
  let current = endpoint, holdDirectory = false, directoryReads = 0, endpointReads = 0, projectReads = 0, movedProjectTeamId = teamId;
  const writes: Record<string, unknown>[] = [];
  const fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const requestUrl = new URL(url, location.origin), path = requestUrl.pathname;
    if (path === "/api/v1/teams") {
      directoryReads++;
      return holdDirectory ? directory.promise : Promise.resolve(response({ items: [{ id: teamId, kind: "ordinary", name: "Engineering", version: 1, createdAt: now, updatedAt: now, membership: { teamId, userId, role: "admin", version: 1, createdAt: now, updatedAt: now } }], nextCursor: null }));
    }
    if (path === "/api/v1/projects") {
      projectReads++;
      expect(requestUrl.searchParams.get("teamId")).toBe(teamId);
      return Promise.resolve(response({ items: [movedProject, eligibleProject].map((project, index) => ({ id: project, name: index === 0 ? "Moved project" : "Eligible project", ownership: { teamId: index === 0 ? movedProjectTeamId : teamId, version: 1 }, repoUrl: "https://example.test/repo.git", settings: { version: 1, executionWarningMinutes: 60 }, createdAt: now, updatedAt: now })).filter(project => project.ownership.teamId === teamId), nextCursor: null }));
    }
    if (path.endsWith("/signing-secret")) return Promise.resolve(response({ endpointId, configVersion: "1", keyId, scheme: "standard-webhooks-v1", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` }));
    if ((init.method ?? "GET") === "GET") {
      if (path === `${base}/${current.id}`) { endpointReads++; if (holdInitialDetail) { holdInitialDetail = false; return initialDetail.promise; } return Promise.resolve(response(current)); }
      if (path === base) return Promise.resolve(response({ items: [{ id: current.id, owner, name: current.name, enabled: true, configVersion: current.configVersion, destination: current.destination, projectCount: current.subscriptions.length, eventTypeCount: current.subscriptions.length, lastAttemptAt: null, lastResult: null }], nextCursor: null }));
      throw new Error(`Unexpected read: ${path}`);
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    writes.push(body);
    if (writes.length === 1) return denied.promise;
    const creating = init.method === "POST";
    current = { ...current, id: creating ? id(15) : endpointId, configVersion: creating ? "1" : "2", name: creating ? body.name as string : current.name, subscriptions: (body.subscriptions as { projectId: string; eventTypes: WebhookActiveEndpoint["subscriptions"][number]["eventTypes"] }[]).map(sub => ({ ...sub, id: id(7), projectName: "Eligible project", eligibility: "eligible" })) };
    return Promise.resolve(response({ endpoint: current, operation: { operationId: body.operationId, kind: creating ? "endpoint.create" : "endpoint.patch", issuedAt: body.issuedAt, requestSha256: createHash("sha256").update(String(init.body)).digest("hex"), actorUserId: userId, owner, endpointId: current.id, effect: "applied", configVersionAfter: current.configVersion, destinationRevisionAfter: "1", deliveryId: null, generationAfter: null, keyId: null, overlapUntil: null, recordedAt: now, expiresAt: "2030-01-01T00:00:00Z" } }, creating ? 201 : 200));
  });
  vi.stubGlobal("fetch", fetch);
  act(() => navigate(`/webhooks?owner=team&teamId=${teamId}&endpointId=${endpointId}&tab=${tab}`));
  const View = () => { const navigation = browserNavigation(), location = useSyncExternalStore(navigation.subscribe, navigation.snapshot), route = parseAuthRoute(location.pathname, location.search); return route.kind === "webhooks" ? <WebhooksPage user={user} admission={admission} active route={route} catalog={catalog}/> : null; };
  renderWithLocale(<View/>, { locale: "en" });
  await waitFor(() => expect(endpointReads).toBe(1));
  await act(async () => { initialDetail.resolve(response(current)); });
  await screen.findByRole("heading", { name: "Existing endpoint", level: 2 });
  return { writes, deny: (code: string) => denied.resolve(refusal(code)), endpointReads: () => endpointReads, directoryReads: () => directoryReads, projectReads: () => projectReads, moveProject: () => { movedProjectTeamId = id(20); }, holdDirectory: () => { holdDirectory = true; }, redact: () => { current = { ...current, destination: { ...current.destination, url: null, displayUrl: "https://receiver.example/…" }, capabilities: { manage: false, readSecret: false, redeliver: false } }; } };
};

describe("Webhook Project eligibility refusal", () => {
  it.each(["create", "subscription"] as const)("retains the %s draft and Team management after a selected Project becomes ineligible", async kind => {
    const view = await mount(kind === "create" ? "configuration" : "subscriptions");
    fireEvent.click(screen.getByRole("button", { name: kind === "create" ? "New webhook" : "Add subscription" }));
    const dialog = screen.getByRole("dialog");
    if (kind === "create") {
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Retained draft" } });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Endpoint URL" }), { target: { value: "https://receiver.example/new" } });
      fireEvent.click(await within(dialog).findByRole("checkbox", { name: /^Moved project/ }));
    } else {
      await within(dialog).findByRole("option", { name: /^Moved project/ });
      fireEvent.change(within(dialog).getByRole("combobox", { name: "Project" }), { target: { value: movedProject } });
    }
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /^task.created/ }));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(view.writes).toHaveLength(1));
    await act(async () => { view.deny("webhook_project_ineligible"); });
    await within(dialog).findByText("webhook_project_ineligible", { exact: false });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("checkbox", { name: /^task.created/ })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: kind === "create" ? "Create webhook" : "Save" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "New webhook" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit Existing endpoint" })).toBeEnabled();
    const reads = view.endpointReads(), teamReads = view.directoryReads(), projectReads = view.projectReads();
    view.moveProject();
    fireEvent.focus(window);
    await waitFor(() => expect(view.endpointReads()).toBeGreaterThan(reads));
    await waitFor(() => expect(view.directoryReads()).toBeGreaterThan(teamReads));
    await waitFor(() => expect(view.projectReads()).toBeGreaterThan(projectReads));
    await waitFor(() => expect(within(dialog).queryByRole(kind === "create" ? "checkbox" : "option", { name: /^Moved project/ })).toBeNull());
    expect(within(dialog).getByRole(kind === "create" ? "checkbox" : "option", { name: movedProject })).toBeVisible();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(document.body.textContent).toContain("private=synthetic");
    expect(screen.queryByText("Member · Read only")).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(view.writes).toHaveLength(1);
    if (kind === "create") {
      expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Retained draft");
      expect(within(dialog).getByRole("textbox", { name: "Endpoint URL" })).toHaveValue("https://receiver.example/new");
      const unavailable = within(dialog).getByRole("checkbox", { name: movedProject });
      expect(unavailable).toBeChecked();
      fireEvent.click(unavailable);
      expect(within(dialog).queryByRole("checkbox", { name: movedProject })).toBeNull();
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /^Eligible project/ }));
    } else fireEvent.change(within(dialog).getByRole("combobox", { name: "Project" }), { target: { value: eligibleProject } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(view.writes).toHaveLength(2);
    expect(view.writes[1]!.operationId).not.toBe(view.writes[0]!.operationId);
    expect(view.writes[1]!.subscriptions).toEqual([{ id: null, projectId: eligibleProject, eventTypes: ["task.created"] }]);
    expect(screen.getByText("Original operation confirmed")).toBeVisible();
    expect(screen.getByRole("button", { name: "New webhook" })).toBeEnabled();
  });

  it("still withdraws privileged data and the draft immediately for a true management denial", async () => {
    const view = await mount("configuration");
    fireEvent.click(screen.getByRole("button", { name: "Show secret" }));
    await screen.findByText(/^whsec_[A-Za-z]/);
    fireEvent.click(screen.getByRole("button", { name: "Edit Existing endpoint" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Administrator draft" } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await waitFor(() => expect(view.writes).toHaveLength(1));
    view.holdDirectory(); view.redact();
    const reads = view.directoryReads();
    await act(async () => { view.deny("forbidden"); });
    await screen.findByText("Member · Read only");
    await waitFor(() => expect(view.directoryReads()).toBeGreaterThan(reads));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain("private=synthetic");
    expect(document.body.textContent).not.toMatch(/whsec_[A-Za-z]/);
    expect(screen.getByRole("button", { name: "New webhook" })).toBeDisabled();
    expect(view.writes).toHaveLength(1);
  });
});
