import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AuthenticatedApp } from "../src/app/AuthenticatedApp";
import { navigate } from "../src/app/router";
import { createLocaleRender } from "./helpers/renderWithLocale";
import { personalTeamPage } from "./helpers/team";
import { directAccessFixture, viewerHeaders } from "./helpers/taskSync";
import { stringifyWireJson } from "./helpers/wireJson";

const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000003";
const sourceId = "00000000-0000-4000-8000-000000000701";
const targetId = "00000000-0000-4000-8000-000000000702";
const time = "2026-10-22T10:00:00Z";
const personal = { id: sourceId, kind: "personal" as const, name: null };
const target = { id: targetId, kind: "ordinary" as const, name: "Destination" };
const user = { id: userId, name: "Alice", email: null, emailVerified: null, avatarUrl: null, personalTeam: personal };
const project = (minutes = 60, version = 1n) => ({
  id: projectId, name: "Project", repoUrl: "https://github.com/example/repo", createdAt: time, updatedAt: time,
  ownership: { teamId: sourceId, version: 1n }, settings: { version, executionWarningMinutes: minutes },
});
const access = { ...directAccessFixture(projectId, userId, "admin"), teamRole: "admin", canTransfer: true };
const json = (body: unknown, status = 200) => new Response(stringifyWireJson(body), {
  status, headers: viewerHeaders(userId, { "Content-Type": "application/json" }),
});
const fail = (status: number, code: string, requestId: string) => json({ error: { code, message: "private error", requestId } }, status);
const render = createLocaleRender("en");

beforeEach(() => {
  window.localStorage.clear(); window.sessionStorage.clear();
  window.history.replaceState(null, "", `/projects/${projectId}/settings`);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

const setup = () => {
  const save = Promise.withResolvers<Response>();
  const transfer = Promise.withResolvers<Response>();
  const permission = Promise.withResolvers<Response>();
  let savedProject = project();
  let identity: typeof user = user;
  let holdPermission = false;
  let denyAccess = false;
  let denials = 0;
  let failRead = false;
  let projectReads = 0;
  let deniedProjectReads = 0;
  let nextProjectRead: PromiseWithResolvers<Response> | null = null;
  let heldProjectReadSignal: AbortSignal | undefined;
  let saveSignal: AbortSignal | undefined;
  let transferSignal: AbortSignal | undefined;
  const respond = (body: unknown, status = 200) => new Response(stringifyWireJson(body), {
    status, headers: viewerHeaders(identity.id, { "Content-Type": "application/json" }),
  });
  const fetcher = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (url === "/api/v1/me") return Promise.resolve(respond(identity));
    if (url.startsWith("/api/v1/teams?")) return Promise.resolve(respond(personalTeamPage(identity.id)));
    if (url === `/api/v1/teams/${sourceId}`) return Promise.resolve(respond(personalTeamPage(identity.id).items[0]));
    if (url.startsWith("/api/v1/projects?")) return Promise.resolve(respond({ items: identity.id === userId ? [savedProject] : [], nextCursor: null }));
    if (url === `/api/v1/projects/${projectId}`) {
      projectReads++;
      if (denyAccess) deniedProjectReads++;
      if (nextProjectRead !== null) {
        const held = nextProjectRead;
        nextProjectRead = null;
        heldProjectReadSignal = init?.signal as AbortSignal;
        return held.promise;
      }
      return failRead ? Promise.reject(new TypeError("read failed")) : Promise.resolve(respond(savedProject));
    }
    if (url === `/api/v1/projects/${projectId}/access`) {
      if (holdPermission) return permission.promise;
      if (denyAccess) { denials++; return Promise.resolve(fail(404, "not_found", "revoked-access")); }
      return Promise.resolve(respond({ ...access, directGrant: { ...access.directGrant!, userId: identity.id } }));
    }
    if (url === `/api/v1/projects/${projectId}/settings` && init?.method === "PATCH") {
      saveSignal = init.signal as AbortSignal;
      return save.promise;
    }
    if (url === `/api/v1/projects/${projectId}/transfer-preview`) return Promise.resolve(json({ sourceTeam: personal, targetTeam: { ...target, version: 1n }, ownership: project().ownership, actorRole: null }));
    if (url === `/api/v1/projects/${projectId}/members`) return Promise.resolve(respond({ items: [], actorAccess: access }));
    if (url === `/api/v1/projects/${projectId}/invitations`) return Promise.resolve(respond({ items: [] }));
    if (url === `/api/v1/projects/${projectId}/transfer`) {
      transferSignal = init?.signal as AbortSignal;
      return transfer.promise;
    }
    if (url.startsWith("/api/v1/me/workers")) return Promise.resolve(new Response(stringifyWireJson({ observedAt: time, items: [], nextCursor: null }), {
      headers: viewerHeaders(identity.id, { "Content-Type": "application/json" }),
    }));
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<AuthenticatedApp />);
  return {
    save, transfer, permission, fetcher,
    get saveSignal() { return saveSignal; }, get transferSignal() { return transferSignal; },
    get heldProjectReadSignal() { return heldProjectReadSignal; },
    get projectReads() { return projectReads; },
    get deniedProjectReads() { return deniedProjectReads; },
    get denials() { return denials; },
    setSavedProject: (value: ReturnType<typeof project>) => { savedProject = value; },
    setIdentity: (value: typeof user) => { identity = value; },
    setFailRead: (value: boolean) => { failRead = value; },
    holdNextProjectRead: () => { const held = Promise.withResolvers<Response>(); nextProjectRead = held; return held; },
    setHoldPermission: (value: boolean) => { holdPermission = value; },
    setDenyAccess: (value: boolean) => { denyAccess = value; },
    saves: () => fetcher.mock.calls.filter(([url, init]) => url.endsWith("/settings") && init?.method === "PATCH").length,
    transfers: () => fetcher.mock.calls.filter(([url]) => url.endsWith("/transfer")).length,
  };
};

const submitSave = async () => {
  const field = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(field).toBeEnabled());
  fireEvent.change(field, { target: { value: "90" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
};
const leave = () => act(() => navigate("/workers"));
const returnToSettings = () => act(() => navigate(`/projects/${projectId}/settings`));
const startTransfer = async () => {
  const open = await screen.findByRole("button", { name: /^Transfer project$/ });
  await waitFor(() => expect(open).toBeEnabled());
  fireEvent.click(open);
  const dialog = screen.getByRole("dialog", { name: "Transfer project" });
  fireEvent.change(within(dialog).getByLabelText("Team ID or link"), { target: { value: targetId } });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Preview" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm transfer" })).toBeEnabled());
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm transfer" }));
};

it("keeps an already dispatched save and its confirmed receipt across real route navigation", async () => {
  const app = setup(); await submitSave();
  await waitFor(() => expect(app.saves()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  app.setSavedProject(project(90, 2n));
  await act(async () => app.save.resolve(json(project(90, 2n))));
  returnToSettings();
  expect(await screen.findByText("Settings saved.")).toBeVisible();
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(app.saves()).toBe(1);
});

it("keeps a definite rejection and draft after navigation without replay", async () => {
  const app = setup(); await submitSave();
  await waitFor(() => expect(app.saves()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  await act(async () => app.save.resolve(fail(400, "invalid_input", "rejected-save")));
  returnToSettings();
  expect(await screen.findByText("rejected-save")).toBeVisible();
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(app.saves()).toBe(1);
});

it.each([
  { status: 409, code: "version_conflict", reason: /settings.*changed|version.*conflict/i },
  { status: 403, code: "forbidden", reason: /save was rejected for insufficient project permission/i },
])("preserves a $status rejection while its read-only reconciliation fails", async ({ status, code, reason }) => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  app.setFailRead(true);
  await act(async () => app.save.resolve(fail(status, code, `rejected-${status}`)));
  returnToSettings();
  expect((await screen.findAllByRole("button", { name: "Retry" })).length).toBeGreaterThan(0);
  expect(await screen.findByText(reason)).toBeVisible();
  expect(screen.queryByText(/current saved value is shown|current access and saved settings have been reloaded|current saved settings have been loaded/i)).toBeNull();
  expect(screen.queryByText("Settings saved.")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
  expect(app.saves()).toBe(1);
  leave(); returnToSettings();
  expect(await screen.findByText(reason)).toBeVisible();
  expect(screen.queryByText(/current saved value is shown|current access and saved settings have been reloaded|current saved settings have been loaded/i)).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
  app.setFailRead(false); app.setSavedProject(project(120, 2n));
  fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
  expect(await screen.findByText(/settings changed while you were away/i)).toBeVisible();
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(120);
  expect(app.saves()).toBe(1);
});

it("keeps an unknown result after failed reconciliation and retries reads only", async () => {
  const app = setup(); await submitSave();
  await waitFor(() => expect(app.saves()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  app.setFailRead(true);
  await act(async () => app.save.reject(new TypeError("save response lost")));
  returnToSettings();
  expect(await screen.findByText(/save outcome could not be confirmed/i)).toBeVisible();
  expect(await screen.findByRole("button", { name: "Load current settings" })).toBeEnabled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
  expect(app.saves()).toBe(1);
  leave(); returnToSettings();
  expect(await screen.findByText(/save outcome could not be confirmed/i)).toBeVisible();
  expect(await screen.findByRole("button", { name: "Load current settings" })).toBeEnabled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
  expect(app.saves()).toBe(1);
  const reads = app.projectReads;
  app.setFailRead(false); app.setSavedProject(project(90, 2n));
  fireEvent.click(screen.getByRole("button", { name: "Load current settings" }));
  expect(await screen.findByText(/current saved settings have been loaded/i)).toBeVisible();
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(app.projectReads).toBeGreaterThan(reads);
  expect(app.saves()).toBe(1);
});

it("reads newer authoritative settings on return without losing the saved receipt", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  app.setSavedProject(project(90, 2n)); await act(async () => app.save.resolve(json(project(90, 2n))));
  app.setSavedProject(project(120, 3n)); const reads = app.projectReads;
  returnToSettings();
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  await waitFor(() => expect(screen.getByLabelText("Alert threshold")).toHaveValue(120));
  expect(screen.getByText("Settings saved.")).toBeVisible();
  expect(app.saves()).toBe(1);
});

it("does not publish an older return read over the confirmed save receipt", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  leave(); const held = app.holdNextProjectRead(); const reads = app.projectReads;
  returnToSettings();
  app.setSavedProject(project(90, 2n)); await act(async () => app.save.resolve(json(project(90, 2n))));
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  expect(await screen.findByText("Settings saved.")).toBeVisible();
  await act(async () => held.resolve(json(project(60, 1n))));
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(screen.getByText("Settings saved.")).toBeVisible();
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(app.saves()).toBe(1);
});

it("keeps a local edit and the read error until a successful return-read retry", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  leave(); app.setSavedProject(project(90, 2n));
  await act(async () => app.save.resolve(json(project(90, 2n))));
  app.setFailRead(true); returnToSettings();
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByText("Settings saved.")).toBeVisible();
  const field = screen.getByLabelText("Alert threshold"); await waitFor(() => expect(field).toBeEnabled());
  fireEvent.change(field, { target: { value: "110" } });
  expect(screen.getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  expect(app.saves()).toBe(1);
  app.setFailRead(false); app.setSavedProject(project(90, 2n));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(110);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled());
  expect(app.saves()).toBe(1);
});

it("keeps the confirmed save while failed access is retried on the same route", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  const accessReads = app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
  app.setHoldPermission(true); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(accessReads));
  app.setSavedProject(project(90, 2n));
  await act(async () => { app.save.resolve(json(project(90, 2n))); app.permission.resolve(fail(503, "unavailable", "access-failed")); });
  expect(await screen.findByText("Settings saved.")).toBeVisible();
  expect(await screen.findByRole("alert")).toBeVisible();
  const field = screen.getByLabelText("Alert threshold"); expect(field).toBeDisabled();
  app.setHoldPermission(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByLabelText("Alert threshold")).toBeEnabled());
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(app.saves()).toBe(1);
});

it("preserves a draft edited before access fails through the later retry", async () => {
  const app = setup(); const field = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(field).toBeEnabled());
  const accessReads = app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
  app.setHoldPermission(true); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(accessReads));
  fireEvent.change(field, { target: { value: "110" } });
  await act(async () => app.permission.resolve(fail(503, "unavailable", "access-failed")));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(field).toBeDisabled(); expect(field).toHaveValue(110);
  app.setHoldPermission(false); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled());
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(110);
  expect(app.saves()).toBe(0);
});

it("cancels a save waiting for fresh permission when its route is left", async () => {
  const app = setup(); const field = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(field).toBeEnabled());
  const before = app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
  app.setHoldPermission(true); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(before));
  fireEvent.change(field, { target: { value: "90" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  leave(); app.setHoldPermission(false);
  await act(async () => app.permission.resolve(json(access)));
  returnToSettings();
  await waitFor(() => expect(screen.getByLabelText("Alert threshold")).toBeEnabled());
  expect(app.saves()).toBe(0);
});

it("invalidates an old account's dispatched save rather than publishing its late result", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  app.setIdentity({ ...user, id: "00000000-0000-4000-8000-000000000002", name: "Bob" });
  vi.mocked(document.hasFocus).mockReturnValue(false); fireEvent(window, new Event("blur"));
  vi.mocked(document.hasFocus).mockReturnValue(true); fireEvent(window, new Event("focus"));
  await screen.findByRole("button", { name: "Account menu: Bob" });
  expect(app.saveSignal?.aborted).toBe(true);
  await act(async () => app.save.resolve(json(project(90, 2n))));
  expect(screen.queryByText("Settings saved.")).toBeNull();
  expect(app.saves()).toBe(1);
});

it("does not reinstall private settings from a late save after trusted access is revoked", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  app.setDenyAccess(true); returnToSettings();
  await waitFor(() => expect(app.denials).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByLabelText("Alert threshold")).toBeNull());
  await act(async () => app.save.resolve(json(project(90, 2n))));
  expect(screen.queryByLabelText("Alert threshold")).toBeNull();
  expect(screen.queryByText("Settings saved.")).toBeNull();
  expect(app.saves()).toBe(1);
});

it.each(["confirmed", "unknown", "conflict"] as const)("keeps a dispatched %s result across off-route revocation and restores it only after access recovers", async (result) => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  app.setDenyAccess(true);
  act(() => navigate(`/projects/${projectId}/members`));
  await waitFor(() => expect(app.denials).toBeGreaterThan(0));
  expect((await screen.findAllByText("Project not found or access unavailable.")).length).toBeGreaterThan(0);
  expect(app.saveSignal?.aborted).toBe(false);
  app.setSavedProject(result === "conflict" ? project(120, 2n) : project(90, 2n));
  if (result === "confirmed") await act(async () => app.save.resolve(json(project(90, 2n))));
  else if (result === "unknown") await act(async () => app.save.reject(new TypeError("save response lost")));
  else await act(async () => app.save.resolve(fail(409, "version_conflict", "save-conflict")));
  expect(app.saveSignal?.aborted).toBe(false);
  expect(screen.queryByText("Settings saved.")).toBeNull();
  expect(screen.queryByText(/save outcome could not be confirmed/i)).toBeNull();
  expect(screen.queryByText(/save was rejected because settings changed/i)).toBeNull();
  expect(screen.queryByText("save-conflict")).toBeNull();
  const denialsBeforeReturn = app.denials;
  returnToSettings();
  await waitFor(() => expect(app.denials).toBeGreaterThan(denialsBeforeReturn));
  await waitFor(() => expect(screen.queryByLabelText("Alert threshold")).toBeNull());
  await waitFor(() => expect(screen.queryByText("Loading project settings…")).toBeNull());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByText("Settings saved.")).toBeNull();
  expect(screen.queryByText(/save outcome could not be confirmed/i)).toBeNull();
  expect(screen.queryByText(/save was rejected because settings changed/i)).toBeNull();
  expect(screen.queryByText(/settings changed elsewhere/i)).toBeNull();
  expect(screen.queryByText("save-conflict")).toBeNull();
  expect(screen.queryByText(/current saved settings have been loaded/i)).toBeNull();
  expect(app.deniedProjectReads).toBe(0);
  const reads = app.projectReads;
  app.setDenyAccess(false); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  const returned = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(returned).toHaveValue(result === "conflict" ? 120 : 90));
  if (result === "confirmed") expect(await screen.findByText("Settings saved.")).toBeVisible();
  else if (result === "unknown") {
    expect(await screen.findByText(/current saved settings have been loaded/i)).toBeVisible();
    expect(screen.queryByText("Settings saved.")).toBeNull();
  } else {
    await waitFor(() => expect(screen.getByText(/settings changed/i)).toBeVisible());
    expect(screen.queryByText("Settings saved.")).toBeNull();
  }
  expect(app.saves()).toBe(1);
});

it("recovers after a confirmed save aborts an older Project read following restored access", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  app.setDenyAccess(true); act(() => navigate(`/projects/${projectId}/members`));
  await waitFor(() => expect(app.denials).toBeGreaterThan(0));
  expect((await screen.findAllByText("Project not found or access unavailable.")).length).toBeGreaterThan(0);
  expect(app.saveSignal?.aborted).toBe(false);
  const denials = app.denials; returnToSettings();
  await waitFor(() => expect(app.denials).toBeGreaterThan(denials));
  await waitFor(() => expect(screen.queryByLabelText("Alert threshold")).toBeNull());
  const held = app.holdNextProjectRead(), before = app.projectReads;
  app.setSavedProject(project(120, 3n)); app.setDenyAccess(false); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(before));
  const heldReadCount = app.projectReads;
  expect(app.heldProjectReadSignal?.aborted).toBe(false);
  await act(async () => app.save.resolve(json(project(90, 2n))));
  await waitFor(() => expect(app.heldProjectReadSignal?.aborted).toBe(true));
  expect(await screen.findByText("Settings saved.")).toBeVisible();
  await waitFor(() => expect(app.projectReads > heldReadCount || screen.queryByRole("button", { name: "Retry" }) !== null).toBe(true));
  if (app.projectReads === heldReadCount) fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const returned = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(returned).toHaveValue(120));
  await act(async () => held.resolve(json(project(60, 1n))));
  expect(returned).toHaveValue(120);
  await waitFor(() => expect(returned).toBeEnabled());
  fireEvent.change(returned, { target: { value: "125" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled());
  expect(app.saves()).toBe(1);
});

it("keeps a failed return-read error and retry when the confirmed save arrives later", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  app.setDenyAccess(true); act(() => navigate(`/projects/${projectId}/members`));
  await waitFor(() => expect(app.denials).toBeGreaterThan(0));
  expect((await screen.findAllByText("Project not found or access unavailable.")).length).toBeGreaterThan(0);
  const denials = app.denials; returnToSettings();
  await waitFor(() => expect(app.denials).toBeGreaterThan(denials));
  const held = app.holdNextProjectRead(), before = app.projectReads;
  app.setDenyAccess(false); app.setFailRead(true); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(before));
  await act(async () => held.resolve(fail(503, "unavailable", "return-read-failed")));
  expect(await screen.findByText("return-read-failed")).toBeVisible();
  expect(app.saveSignal?.aborted).toBe(false);
  app.setSavedProject(project(90, 2n)); await act(async () => app.save.resolve(json(project(90, 2n))));
  expect(await screen.findByText("Settings saved.")).toBeVisible();
  expect(screen.getByText("return-read-failed")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled());
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  app.setFailRead(false); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByText("return-read-failed")).toBeNull());
  const returned = screen.getByLabelText("Alert threshold"); expect(returned).toHaveValue(90);
  fireEvent.change(returned, { target: { value: "110" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled());
  expect(app.saves()).toBe(1);
});

it("keeps a dispatched save private after a Project 404 until a successful resource reread", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  app.setDenyAccess(true); act(() => navigate(`/projects/${projectId}/members`));
  await waitFor(() => expect(app.denials).toBeGreaterThan(0));
  expect((await screen.findAllByText("Project not found or access unavailable.")).length).toBeGreaterThan(0);
  const denials = app.denials; returnToSettings();
  await waitFor(() => expect(app.denials).toBeGreaterThan(denials));
  const held = app.holdNextProjectRead(), before = app.projectReads;
  app.setDenyAccess(false); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(before));
  await act(async () => held.resolve(fail(404, "not_found", "project-not-found")));
  await waitFor(() => expect(screen.queryByLabelText("Alert threshold")).toBeNull());
  expect(app.saveSignal?.aborted).toBe(false);
  app.setSavedProject(project(90, 2n)); await act(async () => app.save.resolve(json(project(90, 2n))));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.queryByText("Settings saved.")).toBeNull();
  expect(screen.queryByLabelText("Alert threshold")).toBeNull();
  const reads = app.projectReads;
  const retry = screen.queryByRole("button", { name: "Retry" });
  if (retry !== null) fireEvent.click(retry); else fireEvent(window, new Event("focus"));
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  expect(await screen.findByText("Settings saved.")).toBeVisible();
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(app.saves()).toBe(1);
});

it("keeps the save owner when a simultaneous rejected transfer is closed first", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  await startTransfer(); await waitFor(() => expect(app.transfers()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false); expect(app.transferSignal?.aborted).toBe(false);
  await act(async () => app.transfer.resolve(fail(400, "invalid_input", "transfer-rejected")));
  returnToSettings();
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(await within(dialog).findByText("transfer-rejected")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  leave(); expect(app.saveSignal?.aborted).toBe(false);
  app.setSavedProject(project(90, 2n)); await act(async () => app.save.resolve(json(project(90, 2n))));
  returnToSettings(); expect(await screen.findByText("Settings saved.")).toBeVisible();
  expect(app.saves()).toBe(1); expect(app.transfers()).toBe(1);
});

it("refreshes the saved settings when only a transfer retains the page off route", async () => {
  const app = setup(); await startTransfer(); await waitFor(() => expect(app.transfers()).toBe(1));
  leave(); expect(app.transferSignal?.aborted).toBe(false);
  app.setSavedProject(project(120, 3n)); const reads = app.projectReads;
  returnToSettings();
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  await waitFor(() => expect(screen.getByLabelText("Alert threshold")).toHaveValue(120));
  expect(app.saves()).toBe(0); expect(app.transfers()).toBe(1);
  await act(async () => app.transfer.resolve(fail(400, "invalid_input", "transfer-rejected")));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(await within(dialog).findByText("transfer-rejected")).toBeVisible();
});

it.each([false, true])("restarts a discarded return read after another route cycle; fresh read fails=%s", async (failFreshRead) => {
  const app = setup(); await startTransfer(); await waitFor(() => expect(app.transfers()).toBe(1));
  await act(async () => app.transfer.reject(new TypeError("transfer response lost")));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(await within(dialog).findByText(/transfer result is unknown/i)).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  leave(); const held = app.holdNextProjectRead(), before = app.projectReads;
  returnToSettings(); await waitFor(() => expect(app.projectReads).toBeGreaterThan(before));
  const oldReadCount = app.projectReads;
  leave(); app.setSavedProject(project(120, 2n)); app.setFailRead(failFreshRead);
  returnToSettings();
  await act(async () => held.resolve(json(project(60, 1n))));
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(oldReadCount));
  if (failFreshRead) {
    expect(await screen.findByText("The operation could not be completed. Please try again.")).toBeVisible();
    const failedReads = app.projectReads;
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(app.projectReads).toBe(failedReads);
    app.setFailRead(false); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(app.projectReads).toBeGreaterThan(failedReads));
  }
  await waitFor(() => expect(screen.getByLabelText("Alert threshold")).toHaveValue(120));
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  expect(app.saves()).toBe(0); expect(app.transfers()).toBe(1);
});

it("keeps a preexisting draft through a return access failure and recovery", async () => {
  const app = setup(); const field = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(field).toBeEnabled()); fireEvent.change(field, { target: { value: "90" } });
  await startTransfer(); await waitFor(() => expect(app.transfers()).toBe(1));
  leave(); app.setHoldPermission(true); const heldProject = app.holdNextProjectRead();
  const reads = app.projectReads;
  const accessReads = app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length;
  returnToSettings();
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  await waitFor(() => expect(app.fetcher.mock.calls.filter(([url]) => url.endsWith("/access")).length).toBeGreaterThan(accessReads));
  await act(async () => { heldProject.resolve(json(project())); app.permission.resolve(fail(503, "unavailable", "access-failed")); });
  await act(async () => app.transfer.resolve(fail(400, "invalid_input", "transfer-rejected")));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(await within(dialog).findByText("transfer-rejected")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const returned = screen.getByLabelText("Alert threshold"); expect(returned).toBeDisabled();
  expect(returned).toHaveValue(90);
  expect(screen.getByText("The operation could not be completed. Please try again.")).toBeVisible();
  app.setHoldPermission(false); fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled());
  expect(screen.getByLabelText("Alert threshold")).toHaveValue(90);
  expect(app.saves()).toBe(0); expect(app.transfers()).toBe(1);
});

it.each([false, true])("treats a cancelled draft and subsequent edit=%s correctly while the return read is pending", async (editAfterCancel) => {
  const app = setup(); const field = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(field).toBeEnabled()); fireEvent.change(field, { target: { value: "90" } });
  await startTransfer(); await waitFor(() => expect(app.transfers()).toBe(1));
  leave(); const held = app.holdNextProjectRead(); const reads = app.projectReads;
  returnToSettings(); await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  await act(async () => app.transfer.resolve(fail(400, "invalid_input", "transfer-rejected")));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(await within(dialog).findByText("transfer-rejected")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const returned = screen.getByLabelText("Alert threshold");
  expect(returned).toHaveValue(90);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(returned).toHaveValue(60);
  if (editAfterCancel) fireEvent.change(returned, { target: { value: "110" } });
  app.setSavedProject(project(120, 2n)); await act(async () => held.resolve(json(project(120, 2n))));
  if (editAfterCancel) {
    expect(await screen.findByText(/settings changed while you were away/i)).toBeVisible();
    expect(returned).toHaveValue(110);
    expect(returned.closest(".project-settings-panel")).toHaveTextContent("120");
  } else {
    await waitFor(() => expect(returned).toHaveValue(120));
    expect(screen.queryByText(/settings changed while you were away/i)).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  expect(app.saves()).toBe(0); expect(app.transfers()).toBe(1);
});

it.each([120, 90])("requires an old draft to be reconciled with newer saved value %i", async (newSaved) => {
  const app = setup(); const field = await screen.findByLabelText("Alert threshold");
  await waitFor(() => expect(field).toBeEnabled());
  fireEvent.change(field, { target: { value: "90" } });
  await startTransfer(); await waitFor(() => expect(app.transfers()).toBe(1));
  leave(); app.setSavedProject(project(newSaved, 2n)); const reads = app.projectReads;
  returnToSettings();
  await waitFor(() => expect(app.projectReads).toBeGreaterThan(reads));
  await act(async () => app.transfer.resolve(fail(400, "invalid_input", "transfer-rejected")));
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(await within(dialog).findByText("transfer-rejected")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  const returned = screen.getByLabelText("Alert threshold"); await waitFor(() => expect(returned).toBeEnabled());
  expect(returned).toHaveValue(90);
  expect(screen.queryByText("Settings saved.")).toBeNull();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  const conflict = screen.queryByText(/settings changed (elsewhere|while you were away)/i);
  if (newSaved !== 90) {
    expect(conflict).toBeVisible();
    expect(returned.closest(".project-settings-panel")).toHaveTextContent(String(newSaved));
  }
  if (conflict !== null) {
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(returned).toHaveValue(newSaved);
    expect(screen.queryByText(/settings changed (elsewhere|while you were away)/i)).toBeNull();
  }
  fireEvent.change(returned, { target: { value: "125" } });
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  expect(app.saves()).toBe(0); expect(app.transfers()).toBe(1);
});

it("keeps the transfer owner when the simultaneous save finishes first", async () => {
  const app = setup(); await submitSave(); await waitFor(() => expect(app.saves()).toBe(1));
  await startTransfer(); await waitFor(() => expect(app.transfers()).toBe(1));
  leave(); expect(app.saveSignal?.aborted).toBe(false); expect(app.transferSignal?.aborted).toBe(false);
  app.setSavedProject(project(90, 2n)); await act(async () => app.save.resolve(json(project(90, 2n))));
  returnToSettings(); expect(await screen.findByText("Settings saved.")).toBeVisible();
  expect(screen.getByRole("dialog", { name: "Transfer project" })).toBeVisible();
  leave(); expect(app.transferSignal?.aborted).toBe(false);
  await act(async () => app.transfer.resolve(fail(400, "invalid_input", "transfer-rejected")));
  returnToSettings();
  const dialog = await screen.findByRole("dialog", { name: "Transfer project" });
  expect(await within(dialog).findByText("transfer-rejected")).toBeVisible();
  expect(app.saves()).toBe(1); expect(app.transfers()).toBe(1);
});
