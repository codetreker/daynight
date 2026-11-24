import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createTaskCacheScope, TaskCacheProvider } from "../src/features/task-cache/TaskCacheProvider";
import { admitTaskGraph, createTaskSessionWorld } from "./helpers/taskSessions";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { taskSyncFromGraph } from "./helpers/taskSync";
import { wireResponse } from "./helpers/wireJson";
import { describe, expect, it, vi } from "vitest";
import type { Attachment, AttachmentPage } from "../src/api/types";
import { ApiError, pauseAuthRequests } from "../src/api/client";
import { type AttachmentApi, type AttachmentWriteResult, useAttachments } from "../src/features/task-detail/attachments/useAttachments";

const project = "10000000-0000-0000-0000-000000000001";
const task = "20000000-0000-0000-0000-000000000001";
const otherTask = "20000000-0000-0000-0000-000000000002";
const time = "2026-10-21T00:00:00Z";
const file = (path: string, contentType = "text/plain"): Attachment => ({ path, contentType, sizeBytes: 10, createdAt: time, updatedAt: time });
const a = file("docs/a.md", "text/markdown");
const b = file("docs/b.txt");
const page = (items: readonly Attachment[], nextCursor: string | null = null): AttachmentPage => ({ items, nextCursor });
const api = () => ({
  list: vi.fn<AttachmentApi["list"]>().mockResolvedValue(page([a, b])),
  put: vi.fn<AttachmentApi["put"]>().mockResolvedValue(a),
  remove: vi.fn<AttachmentApi["remove"]>().mockResolvedValue(undefined),
  readText: vi.fn<AttachmentApi["readText"]>().mockImplementation(async (_project, _task, path) => `Text: ${path}`),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe("attachment pagination", () => {
  it("retains loaded pages after failure, exposes incompleteness, and retries the full list", async () => {
    const transport = api();
    const second = deferred<AttachmentPage>();
    transport.list.mockResolvedValueOnce(page([a], "next")).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.items).toEqual([a]));
    expect(result.current).toMatchObject({ loading: true, complete: false, error: null });
    expect(transport.list.mock.calls[1]?.slice(0, 3)).toEqual([project, task, { limit: 100, cursor: "next" }]);
    const error = new Error("page unavailable");
    await act(async () => { second.reject(error); });
    expect(result.current).toMatchObject({ items: [a], loading: false, complete: false, error });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.items).toEqual([a, b]);
    expect(result.current.error).toBeNull();
  });
  it("retains a known list when a refresh fails on its first page", async () => {
    const transport = api();
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    const failure = new Error("offline");
    transport.list.mockRejectedValueOnce(failure);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current).toMatchObject({ items: [a, b], loading: false, complete: false });
  });
  it("distinguishes an initial failure from an authoritative empty page", async () => {
    const transport = api();
    transport.list.mockRejectedValueOnce(new Error("missing list")).mockResolvedValueOnce(page([]));
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current).toMatchObject({ items: [], loading: false, complete: false });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current).toMatchObject({ items: [], loading: false, error: null });
  });
  it.each(["cursor", "duplicate", "conflict"] as const)("rejects invalid multi-page %s results while retaining valid data", async (scenario) => {
    const transport = api();
    transport.list.mockResolvedValueOnce(page([a], "next")).mockResolvedValueOnce(
      scenario === "cursor" ? page([b], "next") : scenario === "duplicate" ? page([a]) : page([file("docs")]),
    );
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current).toMatchObject({ items: [a], loading: false, complete: false });
    if (scenario === "cursor") expect(result.current.error).toBeInstanceOf(ApiError);
  });
  it("aborts superseded loads and ignores their late successes and failures", async () => {
    const transport = api();
    const old = deferred<AttachmentPage>();
    transport.list.mockReturnValueOnce(old.promise);
    const { result } = renderHook(() => useAttachments(project, task, transport));
    const oldSignal = transport.list.mock.calls[0]![3];
    act(() => result.current.reload());
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.complete).toBe(true));
    await act(async () => { old.resolve(page([])); });
    expect(result.current.items).toEqual([a, b]);
    const stale = deferred<AttachmentPage>();
    transport.list.mockReturnValueOnce(stale.promise);
    act(() => result.current.reload());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.complete).toBe(true));
    await act(async () => { stale.reject(new Error("stale failure")); });
    expect(result.current.error).toBeNull();
  });
  it("does not expose an AbortError as a list failure", async () => {
    const transport = api();
    transport.list.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.error).toBeNull();
  });
});

describe("attachment previews", () => {
  it("loads text and Markdown independently, hides old content immediately, and ignores late text", async () => {
    const transport = api();
    const old = deferred<string>();
    transport.readText.mockReturnValueOnce(old.promise);
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(a.path));
    expect(result.current.preview).toMatchObject({ path: a.path, status: "loading", text: null });
    const oldSignal = transport.readText.mock.calls[0]![3];
    act(() => result.current.select(b.path));
    expect(oldSignal.aborted).toBe(true);
    expect(result.current.preview.text).toBeNull();
    await waitFor(() => expect(result.current.preview.text).toBe(`Text: ${b.path}`));
    await act(async () => { old.resolve("old content"); });
    expect(result.current.preview.text).toBe(`Text: ${b.path}`);
    act(() => result.current.select(null));
    expect(result.current.preview).toMatchObject({ path: null, status: "idle", text: null });
  });
  it("exposes preview failure locally, retries it, and skips text requests for native previews", async () => {
    const transport = api();
    const image = file("image.png", "image/png");
    transport.list.mockResolvedValue(page([a, image]));
    const failure = new Error("text unavailable");
    transport.readText.mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(a.path));
    await waitFor(() => expect(result.current.preview.error).toBe(failure));
    expect(result.current.preview.status).toBe("error");
    act(() => result.current.retryPreview());
    await waitFor(() => expect(result.current.preview.status).toBe("ready"));
    expect(result.current.preview.text).toBe(`Text: ${a.path}`);
    act(() => result.current.select(image.path));
    expect(result.current.preview).toMatchObject({ path: image.path, status: "ready", text: null, error: null });
    expect(transport.readText).toHaveBeenCalledTimes(2);
  });
  it("ignores aborted preview errors and cancels current text on unmount", async () => {
    const transport = api();
    const old = deferred<string>();
    transport.readText.mockReturnValueOnce(old.promise);
    const { result, unmount } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(a.path));
    const first = transport.readText.mock.calls[0]![3];
    act(() => result.current.select(b.path));
    await waitFor(() => expect(result.current.preview.status).toBe("ready"));
    await act(async () => { old.reject(new Error("late")); });
    expect(first.aborted).toBe(true);
    expect(result.current.preview.error).toBeNull();
    const pending = deferred<string>();
    transport.readText.mockReturnValueOnce(pending.promise);
    act(() => result.current.retryPreview());
    const active = transport.readText.mock.calls.at(-1)![3];
    unmount();
    expect(active.aborted).toBe(true);
    await act(async () => { pending.resolve("unmounted"); });
  });
});

describe("attachment writes and identity", () => {
  it("overwrites one file, refreshes only attachments and the selected preview, and rejects concurrent submissions", async () => {
    const transport = api();
    const update = deferred<Attachment>();
    transport.put.mockReturnValueOnce(update.promise);
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(a.path));
    await waitFor(() => expect(result.current.preview.status).toBe("ready"));
    const upload = new File(["new"], "local.txt");
    let resultPromise!: Promise<AttachmentWriteResult>;
    act(() => { resultPromise = result.current.put(a.path, upload); });
    expect(result.current.write).toMatchObject({ status: "saving", error: null });
    await act(async () => { expect(await result.current.put(b.path, upload)).toBe("failed"); });
    expect(transport.put).toHaveBeenCalledTimes(1);
    transport.readText.mockResolvedValueOnce("new content");
    await act(async () => { update.resolve(a); expect(await resultPromise).toBe("published"); });
    await waitFor(() => expect(result.current.preview.text).toBe("new content"));
    expect(result.current.selectedPath).toBe(a.path);
    expect(transport.list).toHaveBeenCalledTimes(2);
    expect(transport.put.mock.calls[0]?.slice(0, 4)).toEqual([project, task, a.path, upload]);
  });
  it("preserves preview and list on failed writes and deletes, with no implicit retry", async () => {
    const transport = api();
    const error = new Error("write may have applied");
    transport.put.mockRejectedValueOnce(error);
    transport.remove.mockRejectedValueOnce(error);
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(a.path));
    await waitFor(() => expect(result.current.preview.status).toBe("ready"));
    await act(async () => { expect(await result.current.put(a.path, new File(["new"], "a.md"))).toBe("failed"); });
    expect(result.current.write).toMatchObject({ status: "idle", error });
    expect(result.current.preview.text).toBe(`Text: ${a.path}`);
    await act(async () => { expect(await result.current.remove(a.path)).toBe("failed"); });
    expect(result.current.selectedPath).toBe(a.path);
    expect(result.current.items).toEqual([a, b]);
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(transport.put).toHaveBeenCalledTimes(1);
    expect(transport.remove).toHaveBeenCalledTimes(1);
  });
  it("deletes exactly one file and clears only its selection on success", async () => {
    const transport = api();
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(a.path));
    await waitFor(() => expect(result.current.preview.status).toBe("ready"));
    transport.list.mockResolvedValueOnce(page([a]));
    await act(async () => { expect(await result.current.remove(b.path)).toBe("published"); });
    expect(result.current.selectedPath).toBe(a.path);
    transport.list.mockResolvedValueOnce(page([]));
    await act(async () => { expect(await result.current.remove(a.path)).toBe("published"); });
    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(result.current).toMatchObject({ selectedPath: null, write: { status: "idle", error: null } });
    expect(result.current.preview.status).toBe("idle");
  });
  it("retains a later-page preview while refreshing after another file is deleted", async () => {
    const transport = api();
    const later = deferred<AttachmentPage>();
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(b.path));
    await waitFor(() => expect(result.current.preview.status).toBe("ready"));
    const preview = result.current.preview;
    transport.list.mockResolvedValueOnce(page([file("first.txt")], "later")).mockReturnValueOnce(later.promise);
    await act(async () => { expect(await result.current.remove(a.path)).toBe("published"); });
    await waitFor(() => expect(result.current.items).toEqual([file("first.txt")]));
    expect(result.current.complete).toBe(false);
    expect(result.current.selected).toBe(b);
    expect(result.current.preview).toBe(preview);
    expect(transport.readText).toHaveBeenCalledTimes(1);
    await act(async () => later.resolve(page([b])));
    expect(result.current.complete).toBe(true);
    expect(result.current.preview).toBe(preview);
    expect(transport.readText).toHaveBeenCalledTimes(1);
  });
  it("hides all old scope state during the first identity render, aborting list, preview and write ownership", async () => {
    const transport = api();
    const write = deferred<Attachment>();
    const text = deferred<string>();
    const next = deferred<AttachmentPage>();
    transport.put.mockReturnValueOnce(write.promise);
    transport.readText.mockReturnValueOnce(text.promise);
    const renders: Array<{ task: string; paths: readonly string[]; selected: string | null; write: string }> = [];
    const { result, rerender } = renderHook(({ id }) => {
      const state = useAttachments(project, id, transport);
      renders.push({ task: id, paths: state.items.map((item) => item.path), selected: state.selectedPath, write: state.write.status });
      return state;
    }, { initialProps: { id: task } });
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(a.path));
    let pending!: Promise<AttachmentWriteResult>;
    act(() => { pending = result.current.put(a.path, new File(["new"], "a.md")); });
    const writeSignal = transport.put.mock.calls[0]![4];
    const previewSignal = transport.readText.mock.calls[0]![3];
    transport.list.mockReturnValueOnce(next.promise);
    const first = renders.length;
    rerender({ id: otherTask });
    expect(renders[first]).toEqual({ task: otherTask, paths: [], selected: null, write: "idle" });
    expect(writeSignal.aborted).toBe(true);
    expect(previewSignal.aborted).toBe(true);
    await act(async () => { write.resolve(a); expect(await pending).toBe("retired"); text.resolve("old text"); next.resolve(page([b])); });
    expect(result.current.items).toEqual([b]);
    expect(result.current.selectedPath).toBeNull();
    expect(result.current.preview.text).toBeNull();
    expect(transport.list).toHaveBeenCalledTimes(2);
  });
  it("ignores late list data across project changes and aborts current work on unmount", async () => {
    const transport = api();
    const old = deferred<AttachmentPage>();
    transport.list.mockReturnValueOnce(old.promise);
    const { result, rerender, unmount } = renderHook(({ id }) => useAttachments(id, task, transport), { initialProps: { id: project } });
    const oldSignal = transport.list.mock.calls[0]![3];
    rerender({ id: otherTask });
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { old.resolve(page([])); });
    expect(result.current.items).toEqual([a, b]);
    const active = deferred<AttachmentPage>();
    transport.list.mockReturnValueOnce(active.promise);
    act(() => result.current.reload());
    const activeSignal = transport.list.mock.calls.at(-1)![3];
    unmount();
    expect(activeSignal.aborted).toBe(true);
    await act(async () => { active.reject(new Error("late failure")); });
  });
  it("clears saving state for a transport AbortError without displaying it", async () => {
    const transport = api();
    transport.put.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    await act(async () => { expect(await result.current.put(a.path, new File(["x"], "x"))).toBe("failed"); });
    expect(result.current.write).toMatchObject({ status: "idle", error: null });
  });
});

describe("native preview identity", () => {
  it.each(["html", "pdf"] as const)("publishes %s directly after inventory admission and reloads locally", async (extension) => {
    const transport = api();
    const item = file(`preview.${extension}`, extension === "html" ? "text/html" : "application/pdf");
    const inventory = deferred<AttachmentPage>();
    transport.list.mockReturnValueOnce(inventory.promise);
    const { result } = renderHook(() => useAttachments(project, task, transport, { requireCompleteInventory: true }));
    act(() => result.current.select(item.path));
    expect(result.current.preview.status).toBe("loading");
    await act(async () => { inventory.resolve(page([item])); });
    expect(result.current.preview).toMatchObject({ path: item.path, status: "ready", text: null, nativeSource: { updatedAt: time, reloadRevision: 0 } });
    act(() => result.current.retryPreview());
    expect(result.current.preview).toMatchObject({ nativeSource: { updatedAt: time, reloadRevision: 1 } });
    expect(transport.list).toHaveBeenCalledOnce();
    expect(transport.readText).not.toHaveBeenCalled();
  });

  it.each([false, true])("publishes PUT metadata once while inventory is pending (complete inventory %s)", async (requireCompleteInventory) => {
    const transport = api();
    const item = file("index.html", "text/html");
    const updated = { ...item, updatedAt: "2026-10-21T01:00:00Z" };
    const inventory = deferred<AttachmentPage>();
    transport.list.mockResolvedValueOnce(page([item])).mockReturnValueOnce(inventory.promise);
    transport.put.mockResolvedValueOnce(updated);
    const sources: string[] = [];
    const { result } = renderHook(() => {
      const state = useAttachments(project, task, transport, { requireCompleteInventory });
      if (state.preview.status === "ready" && state.preview.nativeSource) {
        const source = JSON.stringify(state.preview.nativeSource);
        if (sources.at(-1) !== source) sources.push(source);
      }
      return state;
    });
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(item.path));
    await waitFor(() => expect(result.current.preview.status).toBe("ready"));
    await act(async () => { expect(await result.current.put(item.path, new File(["new"], "index.html"))).toBe("published"); });
    expect(result.current.selected).toEqual(updated);
    expect(result.current.complete).toBe(false);
    expect(result.current.preview.nativeSource).toEqual({ updatedAt: updated.updatedAt, reloadRevision: 1 });
    await act(async () => { inventory.resolve(page([updated])); });
    expect(result.current.complete).toBe(true);
    expect(sources).toEqual([JSON.stringify({ updatedAt: time, reloadRevision: 0 }), JSON.stringify({ updatedAt: updated.updatedAt, reloadRevision: 1 })]);
  });
});

describe("selected preview refresh coherence", () => {
  it.each([a, b])("reloads current text only when selected metadata changes for $path", async (item) => {
    const transport = api();
    const updated = { ...item, updatedAt: "2026-10-21T01:00:00Z" };
    transport.list.mockResolvedValue(page([item]));
    transport.readText.mockResolvedValueOnce("original content").mockResolvedValueOnce("externally replaced content");
    const { result } = renderHook(() => useAttachments(project, task, transport));
    await waitFor(() => expect(result.current.complete).toBe(true));
    act(() => result.current.select(item.path));
    await waitFor(() => expect(result.current.preview.text).toBe("original content"));
    act(() => result.current.reload());
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(transport.readText).toHaveBeenCalledTimes(1);
    transport.list.mockResolvedValueOnce(page([updated]));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.preview.text).toBe("externally replaced content"));
    expect(result.current.selectedPath).toBe(item.path);
    expect(transport.readText).toHaveBeenCalledTimes(2);
    expect(transport.list).toHaveBeenCalledTimes(3);
  });
});

it("withdraws an attachment preview and late text when the shared baseline commits its Task deletion", async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task), survivor = detailFixture(project, otherTask);
  await world.sync([target, survivor]);
  const transport = api();
  const held = deferred<string>(); transport.readText.mockReturnValueOnce(held.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    act(() => view.result.current.select(a.path));
    await waitFor(() => expect(transport.readText).toHaveBeenCalledOnce());
    const signal = transport.readText.mock.calls[0]![3];
    const generation = world.scope.getHistoryGeneration(project);
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const sync = taskSyncFromGraph(graphFixture([survivor]), { epoch: ticket.epoch!, query: { epoch: ticket.epoch! }, versionForTask: () => 1n, propertiesForTask: () => survivor.properties });
    await act(async () => { await world.scope.applySync(ticket, { ...sync, deletedTaskIds: [task] }, world.scope.signal); });
    expect(signal.aborted).toBe(true);
    expect(view.result.current.selectedPath).toBeNull();
    expect(view.result.current.items).toEqual([]);
    await act(async () => held.resolve("deleted private content"));
    expect(view.result.current.preview.text).toBeNull();
    expect(await view.result.current.put(a.path, new File(["replacement"], "a.md"))).toBe("failed");
    expect(transport.put).not.toHaveBeenCalled();
    expect(world.scope.getHistoryGeneration(project)).toBe(generation);
    expect(world.scope.getAuthorizedProject(project)?.summaries.has(otherTask)).toBe(true);
  } finally { view.unmount(); world.dispose(); }
});

it("preserves a selected iframe and pending attachment write when a full rebuild retains its Task", async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const document = file("index.html", "text/html");
  const transport = api(); transport.list.mockResolvedValue(page([document]));
  const held = deferred<Attachment>(); transport.put.mockReturnValueOnce(held.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    act(() => view.result.current.select(document.path));
    await waitFor(() => expect(view.result.current.preview.status).toBe("ready"));
    const iframe = view.result.current.preview.nativeSource;
    let write!: Promise<AttachmentWriteResult>;
    act(() => { write = view.result.current.put(document.path, new File(["changed"], "index.html")); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    const signal = transport.put.mock.calls[0]![4];
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const snapshot = taskSyncFromGraph(graphFixture([target]), { epoch: ticket.epoch!, query: {}, versionForTask: () => target.version, propertiesForTask: () => target.properties });
    await act(async () => { await world.scope.applySync(ticket, snapshot, world.scope.signal, true, { rebuild: true }); });
    expect(signal.aborted).toBe(false);
    expect(view.result.current.write.status).toBe("saving");
    expect(view.result.current.selectedPath).toBe(document.path);
    expect(view.result.current.preview.nativeSource).toBe(iframe);
    expect(await view.result.current.put(document.path, new File(["again"], "index.html"))).toBe("failed");
    await act(async () => { held.resolve(document); expect(await write).toBe("published"); });
    expect(transport.put).toHaveBeenCalledOnce();
  } finally { view.unmount(); world.dispose(); }
});

it.each(['put', 'remove'].flatMap(operation => ['success', 'failure'].map(outcome => ({ operation, outcome }))))('releases a retired $operation attachment owner after history replacement without losing a newer write on old $outcome', async ({ operation, outcome }) => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const transport = api();
  const oldPut = deferred<Attachment>(), newPut = deferred<Attachment>();
  const oldRemove = deferred<void>(), newRemove = deferred<void>();
  if (operation === 'put') transport.put.mockReturnValueOnce(oldPut.promise).mockReturnValueOnce(newPut.promise);
  else transport.remove.mockReturnValueOnce(oldRemove.promise).mockReturnValueOnce(newRemove.promise);
  const writeApi = operation === 'put' ? transport.put : transport.remove;
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  const write = () => operation === 'put' ? view.result.current.put(a.path, new File(['changed'], 'a.md')) : view.result.current.remove(a.path);
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let oldResult!: Promise<AttachmentWriteResult>; act(() => { oldResult = write(); });
    await waitFor(() => expect(writeApi).toHaveBeenCalledOnce());
    const oldSignal = operation === 'put' ? transport.put.mock.calls[0]![4] : transport.remove.mock.calls[0]![3];
    const replacement = { ...target, title: 'Restored task', version: 3n };
    await act(async () => { await admitTaskGraph(world.scope, graphFixture([replacement]), { epoch: crypto.randomUUID(), versionForTask: () => replacement.version, propertiesForTask: () => replacement.properties }); });
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    expect(oldSignal.aborted).toBe(true);
    expect(view.result.current.write.status).toBe('idle');
    let newResult!: Promise<AttachmentWriteResult>; act(() => { newResult = write(); });
    await waitFor(() => expect(writeApi).toHaveBeenCalledTimes(2));
    const newSignal = operation === 'put' ? transport.put.mock.calls[1]![4] : transport.remove.mock.calls[1]![3];
    await act(async () => {
      if (outcome === 'failure') (operation === 'put' ? oldPut : oldRemove).reject(new Error('Retired attachment response lost'));
      else if (operation === 'put') oldPut.resolve(a);
      else oldRemove.resolve();
      expect(await oldResult).toBe(outcome === "success" ? "retired" : "failed");
    });
    expect(view.result.current.write.status).toBe(operation === 'put' ? 'saving' : 'deleting');
    expect(newSignal.aborted).toBe(false);
    expect(await write()).toBe("failed");
    expect(writeApi).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (operation === 'put') newPut.resolve(a);
      else newRemove.resolve();
      expect(await newResult).toBe("published");
    });
    expect(view.result.current.write).toMatchObject({ status: 'idle', error: null });
  } finally { view.unmount(); world.dispose(); }
});

it('restarts an incomplete attachment list when a retained Task changes during manual rebuild', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const transport = api(), old = deferred<AttachmentPage>();
  transport.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([b]));
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(transport.list).toHaveBeenCalledOnce());
    const oldSignal = transport.list.mock.calls[0]![3];
    const changed = { ...target, title: 'Updated task', version: 2n, updatedAt: '2026-10-23T00:00:00Z' };
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const snapshot = taskSyncFromGraph(graphFixture([changed]), { epoch: ticket.epoch!, query: {}, versionForTask: () => changed.version, propertiesForTask: () => changed.properties });
    await act(async () => { await world.scope.applySync(ticket, snapshot, world.scope.signal, true, { rebuild: true }); });
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current).toMatchObject({ items: [b], complete: true, loading: false, error: null }));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => old.resolve(page([a])));
    expect(view.result.current.items).toEqual([b]);
  } finally { view.unmount(); world.dispose(); }
});

it('retains a selected native preview and pending write while restarting an interrupted inventory', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const document = file('index.html', 'text/html'), old = deferred<AttachmentPage>(), saved = deferred<Attachment>();
  const transport = api();
  transport.list.mockResolvedValueOnce(page([document])).mockReturnValueOnce(old.promise).mockResolvedValue(page([document]));
  transport.put.mockReturnValueOnce(saved.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    act(() => view.result.current.select(document.path));
    await waitFor(() => expect(view.result.current.preview.status).toBe('ready'));
    const original = view.result.current.preview.nativeSource;
    let write!: Promise<AttachmentWriteResult>;
    act(() => { write = view.result.current.put(document.path, new File(['draft'], 'index.html')); view.result.current.reload(); });
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    const writeSignal = transport.put.mock.calls[0]![4];
    const changed = { ...target, title: 'Updated task', version: 2n, updatedAt: '2026-10-23T00:00:00Z' };
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const snapshot = taskSyncFromGraph(graphFixture([changed]), { epoch: ticket.epoch!, query: {}, versionForTask: () => changed.version, propertiesForTask: () => changed.properties });
    await act(async () => { await world.scope.applySync(ticket, snapshot, world.scope.signal, true, { rebuild: true }); });
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    expect(view.result.current.selectedPath).toBe(document.path);
    expect(view.result.current.preview.nativeSource).toBe(original);
    expect(view.result.current.write.status).toBe('saving');
    expect(writeSignal.aborted).toBe(false);
    await act(async () => { old.resolve(page([])); saved.resolve(document); expect(await write).toBe("confirmed"); });
    expect(view.result.current.items).toEqual([document]);
    expect(view.result.current.selectedPath).toBe(document.path);
    expect(view.result.current.write.status).toBe('idle');
  } finally { view.unmount(); world.dispose(); }
});

it('restarts an in-flight text preview when the retained Task version changes', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const transport = api(), old = deferred<string>();
  transport.readText.mockReturnValueOnce(old.promise).mockResolvedValueOnce('Current text');
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    act(() => view.result.current.select(a.path));
    await waitFor(() => expect(transport.readText).toHaveBeenCalledOnce());
    const signal = transport.readText.mock.calls[0]![3];
    const changed = { ...target, title: 'Updated task', version: 2n, updatedAt: '2026-10-23T00:00:00Z' };
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const snapshot = taskSyncFromGraph(graphFixture([changed]), { epoch: ticket.epoch!, query: {}, versionForTask: () => changed.version, propertiesForTask: () => changed.properties });
    await act(async () => { await world.scope.applySync(ticket, snapshot, world.scope.signal, true, { rebuild: true }); });
    await waitFor(() => expect(view.result.current.preview.text).toBe('Current text'));
    expect(signal.aborted).toBe(true);
    expect(view.result.current.selectedPath).toBe(a.path);
    expect(transport.list).toHaveBeenCalledOnce();
    await act(async () => old.resolve('Stale text'));
    expect(view.result.current.preview.text).toBe('Current text');
  } finally { view.unmount(); world.dispose(); }
});

it('keeps an in-flight attachment list when the first ordinary snapshot includes its Task', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task), pending = deferred<AttachmentPage>();
  const transport = api(); transport.list.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(transport.list).toHaveBeenCalledOnce());
    const signal = transport.list.mock.calls[0]![3];
    await act(async () => { await world.sync([target]); });
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve(page([a])));
    await waitFor(() => expect(view.result.current).toMatchObject({ items: [a], loading: false, complete: true, error: null }));
    expect(transport.list).toHaveBeenCalledOnce();
  } finally { view.unmount(); world.dispose(); }
});

it('offers a list retry when a rebuild notification is missed and an old response loses admission', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const transport = api(), old = deferred<AttachmentPage>();
  transport.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([b]));
  const subscribe = vi.spyOn(world.scope, 'subscribe').mockReturnValue(() => {});
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(transport.list).toHaveBeenCalledOnce());
    const changed = { ...target, title: 'Updated task', version: 2n, updatedAt: '2026-10-23T00:00:00Z' };
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const snapshot = taskSyncFromGraph(graphFixture([changed]), { epoch: ticket.epoch!, query: {}, versionForTask: () => changed.version, propertiesForTask: () => changed.properties });
    await act(async () => { await world.scope.applySync(ticket, snapshot, world.scope.signal, true, { rebuild: true }); old.resolve(page([a])); });
    await waitFor(() => expect(view.result.current).toMatchObject({ loading: false, complete: false, items: [] }));
    expect(view.result.current.error).toBeInstanceOf(DOMException);
    act(() => view.result.current.reload());
    await waitFor(() => expect(view.result.current).toMatchObject({ loading: false, complete: true, items: [b], error: null }));
    expect(transport.list).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); subscribe.mockRestore(); world.dispose(); }
});

it('offers a preview retry when a rebuild notification is missed and old text loses admission', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const transport = api(), old = deferred<string>();
  transport.readText.mockReturnValueOnce(old.promise).mockResolvedValueOnce('Current text');
  const subscribe = vi.spyOn(world.scope, 'subscribe').mockReturnValue(() => {});
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    act(() => view.result.current.select(a.path));
    await waitFor(() => expect(transport.readText).toHaveBeenCalledOnce());
    const changed = { ...target, title: 'Updated task', version: 2n, updatedAt: '2026-10-23T00:00:00Z' };
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const snapshot = taskSyncFromGraph(graphFixture([changed]), { epoch: ticket.epoch!, query: {}, versionForTask: () => changed.version, propertiesForTask: () => changed.properties });
    await act(async () => { await world.scope.applySync(ticket, snapshot, world.scope.signal, true, { rebuild: true }); old.resolve('Stale text'); });
    await waitFor(() => expect(view.result.current.preview.status).toBe('error'));
    expect(view.result.current.preview.text).toBeNull();
    act(() => view.result.current.retryPreview());
    await waitFor(() => expect(view.result.current.preview.text).toBe('Current text'));
    expect(transport.readText).toHaveBeenCalledTimes(2);
  } finally { view.unmount(); subscribe.mockRestore(); world.dispose(); }
});

it('releases the write control when admission expires before dispatch', async () => {
  const world = createTaskSessionWorld();
  await world.sync([detailFixture(project, task)]);
  const transport = api();
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    const verify = vi.spyOn(world.scope, 'verifyTaskRead').mockResolvedValueOnce(false);
    await act(async () => { expect(await view.result.current.put(a.path, new File(['draft'], 'a.md'))).toBe("failed"); });
    expect(transport.put).not.toHaveBeenCalled();
    expect(view.result.current.write.status).toBe('idle');
    expect(view.result.current.write.error).toBeInstanceOf(DOMException);
    verify.mockRestore();
  } finally { view.unmount(); world.dispose(); }
});

it.each(['put', 'remove'].flatMap(operation => ['false', 'throw'].map(verification => ({ operation, verification }))))('retains a confirmed $operation when post-write admission returns $verification', async ({ operation, verification }) => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task);
  await world.sync([target]);
  const transport = api();
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    const verify = vi.spyOn(world.scope, 'verifyTaskRead');
    verify.mockResolvedValueOnce(true);
    if (verification === 'false') verify.mockResolvedValueOnce(false);
    else verify.mockRejectedValueOnce(new Error('storage unavailable'));
    await act(async () => {
      const result = operation === 'put' ? await view.result.current.put(a.path, new File(['new'], 'a.md')) : await view.result.current.remove(a.path);
      expect(result).toBe('confirmed');
    });
    expect(view.result.current.write).toMatchObject({ status: 'idle', error: null });
    expect(view.result.current.confirmedUnpublished).toBe(true);
    expect(view.result.current.error).not.toBeNull();
    expect(view.result.current.items).toEqual([a, b]);
    expect(operation === 'put' ? transport.put : transport.remove).toHaveBeenCalledOnce();
    verify.mockRestore();
    act(() => view.result.current.reload());
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    expect(view.result.current.confirmedUnpublished).toBe(false);
    expect(operation === 'put' ? transport.put : transport.remove).toHaveBeenCalledOnce();
  } finally { view.unmount(); world.dispose(); }
});

it('settles a confirmed write after an identity pause and permits a later write', async () => {
  const world = createTaskSessionWorld(); await world.sync([detailFixture(project, task)]);
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  let resume = () => {};
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['first'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => { pending.resolve(a); await Promise.resolve(); });
    expect(view.result.current.write.status).toBe('confirmed');
    await act(async () => { resume(); expect(await write).toBe('confirmed'); });
    expect(view.result.current.write.status).toBe('idle');
    expect(view.result.current.confirmedUnpublished).toBe(true);
    await act(async () => { expect(await view.result.current.put(b.path, new File(['second'], 'b.txt'))).toBe('published'); });
    expect(transport.put).toHaveBeenCalledTimes(2);
  } finally { resume(); view.unmount(); world.dispose(); }
});

it('retires a confirmed old-history write after a fresh read confirms a peer epoch without a notification', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task); await world.sync([target]);
  const original = await world.scope.beginSync(project, world.scope.signal);
  const peer = createTaskCacheScope({ userId: world.scope.userId, onIdentityMismatch: () => { throw new Error('identity mismatch'); } });
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['old'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    await admitTaskGraph(peer, graphFixture([target]), { epoch: original.epoch!, versionForTask: () => target.version, propertiesForTask: () => target.properties });
    const peerTicket = await peer.beginSync(project, peer.signal);
    const replacement = { ...target, title: 'New history', version: 2n }, nextEpoch = crypto.randomUUID();
    const snapshot = taskSyncFromGraph(graphFixture([replacement]), { epoch: nextEpoch, query: {}, versionForTask: () => replacement.version, propertiesForTask: () => replacement.properties });
    await act(async () => { await peer.applySync(peerTicket, snapshot, peer.signal, true, { rebuild: true, atomicHistory: true }); pending.resolve(a); });
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => wireResponse(replacement, { headers: { 'Daynight-User-ID': world.scope.userId, 'Daynight-Task-Epoch': nextEpoch } }));
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('retired'); });
    fetch.mockRestore();
    expect(view.result.current.confirmedUnpublished).toBe(false);
    expect(view.result.current.write.status).toBe('idle');
    expect(view.result.current.items).toEqual([]);
    expect(transport.put).toHaveBeenCalledOnce();
  } finally { view.unmount(); peer.dispose(); world.dispose(); vi.unstubAllGlobals(); }
});

it('retains a confirmed direct write when its first full baseline matches its observed epoch', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task), epoch = crypto.randomUUID();
  const direct = await world.scope.beginTaskRead(project, task, 0, 0, world.scope.signal);
  expect(await world.scope.observeHistory(direct, epoch, world.scope.signal)).toBe('current');
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['first'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    const ticket = await world.scope.beginSync(project, world.scope.signal);
    const snapshot = taskSyncFromGraph(graphFixture([target]), { epoch, query: {}, versionForTask: () => target.version, propertiesForTask: () => target.properties });
    await act(async () => { await world.scope.applySync(ticket, snapshot, world.scope.signal, true, { rebuild: true }); pending.resolve(a); expect(await write).toBe('confirmed'); });
    expect(view.result.current.confirmedUnpublished).toBe(true);
    expect(view.result.current.write).toMatchObject({ status: 'idle', error: null });
  } finally { view.unmount(); world.dispose(); }
});

it('holds a confirmed write until its history can be checked and permits a later write', async () => {
  const world = createTaskSessionWorld(); await world.sync([detailFixture(project, task)]);
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  let resume = () => {};
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['first'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    const qualification = vi.spyOn(world.scope, 'taskReadQualification').mockRejectedValue(new Error('storage unavailable'));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => { pending.resolve(a); await Promise.resolve(); });
    act(() => resume());
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    expect(view.result.current.write.status).toBe('confirmed');
    await act(async () => { expect(await view.result.current.put(b.path, new File(['duplicate'], 'b.txt'))).toBe('failed'); });
    expect(transport.put).toHaveBeenCalledOnce();
    let resumeAgain = () => {};
    act(() => { resumeAgain = pauseAuthRequests(); });
    expect(view.result.current.write.status).toBe('confirmed');
    act(() => resumeAgain());
    expect(view.result.current.write.status).toBe('confirmed');
    qualification.mockRestore();
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('confirmed'); });
    expect(view.result.current.confirmationPending).toBe(false);
    expect(view.result.current.confirmedUnpublished).toBe(true);
    act(() => view.result.current.reload());
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    await act(async () => { expect(await view.result.current.put(b.path, new File(['next'], 'b.txt'))).toBe('published'); });
    expect(transport.put).toHaveBeenCalledTimes(2);
  } finally { resume(); view.unmount(); world.dispose(); }
});

it('retires a confirmed write when a peer records access withdrawal without a notification', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task); await world.sync([target]);
  const original = await world.scope.beginSync(project, world.scope.signal);
  const peer = createTaskCacheScope({ userId: world.scope.userId, onIdentityMismatch: () => { throw new Error('identity mismatch'); } });
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['old'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    await admitTaskGraph(peer, graphFixture([target]), { epoch: original.epoch!, versionForTask: () => target.version, propertiesForTask: () => target.properties });
    const peerTicket = await peer.beginSync(project, peer.signal);
    await act(async () => { expect(await peer.revokeProject(peerTicket, peer.signal, true)).toBe(true); pending.resolve(a); });
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'denied' } }, { status: 404, headers: { 'Daynight-User-ID': world.scope.userId } }));
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('retired'); });
    fetch.mockRestore();
    expect((await world.scope.taskReadQualification(project, task, world.scope.signal)).baselineState).toBe('access');
    expect(view.result.current.confirmedUnpublished).toBe(false);
    expect(view.result.current.write.status).toBe('idle');
    expect(view.result.current.items).toEqual([]);
    expect(view.result.current.error).not.toBeNull();
    expect(transport.put).toHaveBeenCalledOnce();
  } finally { view.unmount(); peer.dispose(); world.dispose(); vi.unstubAllGlobals(); }
});

it('checks a confirmed write with a fresh direct Task read when history is uncertain and no graph is mounted', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task); await world.sync([target]);
  const epoch = (await world.scope.beginSync(project, world.scope.signal)).epoch!;
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['first'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    const verify = vi.spyOn(world.scope, 'verifyTaskRead').mockResolvedValueOnce(false);
    const actual = world.scope.isTaskOperationHistoryConfirmedCurrent.bind(world.scope);
    let checks = 0;
    const history = vi.spyOn(world.scope, 'isTaskOperationHistoryConfirmedCurrent').mockImplementation(fence => ++checks <= 2 ? false : actual(fence));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(wireResponse(target, { headers: { 'Daynight-User-ID': world.scope.userId, 'Daynight-Task-Epoch': epoch } }));
    await act(async () => { pending.resolve(a); });
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('confirmed'); });
    expect(fetch).toHaveBeenCalledOnce();
    expect(view.result.current.confirmedUnpublished).toBe(true);
    expect(transport.put).toHaveBeenCalledOnce();
    fetch.mockRestore(); history.mockRestore(); verify.mockRestore();
  } finally { view.unmount(); world.dispose(); }
});

it('checks an unsummarized Task with a fresh direct read before settling its confirmed write', async () => {
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task), survivor = detailFixture(project, otherTask);
  await world.sync([survivor]);
  const epoch = (await world.scope.beginSync(project, world.scope.signal)).epoch!;
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['first'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    const verify = vi.spyOn(world.scope, 'verifyTaskRead').mockResolvedValueOnce(false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(wireResponse(target, { headers: { 'Daynight-User-ID': world.scope.userId, 'Daynight-Task-Epoch': epoch } }));
    await act(async () => pending.resolve(a));
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('confirmed'); });
    expect(fetch).toHaveBeenCalledOnce(); expect(transport.put).toHaveBeenCalledOnce();
    expect(view.result.current.confirmedUnpublished).toBe(true);
    fetch.mockRestore(); verify.mockRestore();
  } finally { view.unmount(); world.dispose(); }
});

it('settles a receipt after identity pause starts during its post-write admission check', async () => {
  const world = createTaskSessionWorld(); await world.sync([detailFixture(project, task)]);
  const transport = api(), verification = deferred<boolean>();
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  let resume = () => {};
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    const verify = vi.spyOn(world.scope, 'verifyTaskRead'); verify.mockResolvedValueOnce(true).mockReturnValueOnce(verification.promise);
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['first'], 'a.md')); });
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => { verification.resolve(true); await Promise.resolve(); });
    await act(async () => { resume(); expect(await write).toBe('confirmed'); });
    expect(view.result.current.confirmedUnpublished).toBe(true);
    expect(view.result.current.write.status).toBe('idle');
    verify.mockRestore();
  } finally { resume(); view.unmount(); world.dispose(); }
});

it('settles an old-epoch receipt when a fresh direct read disproves an unordered peer epoch', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task); await world.sync([target]);
  const original = await world.scope.beginSync(project, world.scope.signal);
  const peer = createTaskCacheScope({ userId: world.scope.userId, onIdentityMismatch: () => { throw new Error('identity mismatch'); } });
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['old'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    await admitTaskGraph(peer, graphFixture([target]), { epoch: original.epoch!, versionForTask: () => target.version, propertiesForTask: () => target.properties });
    const peerTicket = await peer.beginSync(project, peer.signal);
    const replacement = { ...target, title: 'Unordered snapshot', version: 2n };
    const peerEpoch = crypto.randomUUID();
    const snapshot = taskSyncFromGraph(graphFixture([replacement]), { epoch: peerEpoch, query: {}, versionForTask: () => replacement.version, propertiesForTask: () => replacement.properties });
    await act(async () => { await peer.applySync(peerTicket, snapshot, peer.signal, true, { rebuild: true, atomicHistory: true });
      const deletionTicket = await peer.beginSync(project, peer.signal);
      const survivor = detailFixture(project, otherTask);
      const delta = taskSyncFromGraph(graphFixture([survivor]), { epoch: peerEpoch, query: { epoch: peerEpoch }, versionForTask: () => survivor.version, propertiesForTask: () => survivor.properties });
      await peer.applySync(deletionTicket, { ...delta, deletedTaskIds: [task] }, peer.signal);
      pending.resolve(a); });
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(wireResponse(target, { headers: { 'Daynight-User-ID': world.scope.userId, 'Daynight-Task-Epoch': original.epoch! } }));
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('confirmed'); });
    expect(fetch).toHaveBeenCalledOnce(); expect(transport.put).toHaveBeenCalledOnce();
    expect(view.result.current.confirmedUnpublished).toBe(true);
    fetch.mockRestore();
  } finally { view.unmount(); peer.dispose(); world.dispose(); vi.unstubAllGlobals(); }
});

it('retains a confirmed write across an unordered peer history hint until a fresh read confirms the original epoch', async () => {
  class Channel {
    static all = new Set<Channel>();
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) { Channel.all.add(this); }
    postMessage(data: unknown) { for (const peer of Channel.all) if (peer !== this && peer.name === this.name) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent<unknown>)); }
    close() { Channel.all.delete(this); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task); await world.sync([target]);
  const original = await world.scope.beginSync(project, world.scope.signal);
  const peer = createTaskCacheScope({ userId: world.scope.userId, onIdentityMismatch: () => { throw new Error('identity mismatch'); } });
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['old'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    const events: { historyHint?: true }[] = [], unsubscribe = world.scope.subscribe(event => events.push(event));
    await admitTaskGraph(peer, graphFixture([target]), { epoch: original.epoch!, versionForTask: () => target.version, propertiesForTask: () => target.properties });
    const peerTicket = await peer.beginSync(project, peer.signal);
    const replacement = { ...target, title: 'Unordered snapshot', version: 2n };
    const snapshot = taskSyncFromGraph(graphFixture([replacement]), { epoch: crypto.randomUUID(), query: {}, versionForTask: () => replacement.version, propertiesForTask: () => replacement.properties });
    await act(async () => { await peer.applySync(peerTicket, snapshot, peer.signal, true, { rebuild: true, atomicHistory: true }); });
    await waitFor(() => expect(events.some(event => event.historyHint)).toBe(true)); unsubscribe();
    await act(async () => pending.resolve(a));
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(wireResponse(target, { headers: { 'Daynight-User-ID': world.scope.userId, 'Daynight-Task-Epoch': original.epoch! } }));
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('confirmed'); });
    expect(fetch).toHaveBeenCalledOnce(); expect(transport.put).toHaveBeenCalledOnce();
    expect(view.result.current.confirmedUnpublished).toBe(true);
    fetch.mockRestore();
  } finally { view.unmount(); peer.dispose(); world.dispose(); vi.unstubAllGlobals(); }
});

it('settles a confirmed write after a fresh read disproves an unordered access tombstone', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const world = createTaskSessionWorld();
  const target = detailFixture(project, task); await world.sync([target]);
  const original = await world.scope.beginSync(project, world.scope.signal);
  const peer = createTaskCacheScope({ userId: world.scope.userId, onIdentityMismatch: () => { throw new Error('identity mismatch'); } });
  const transport = api(), pending = deferred<Attachment>(); transport.put.mockReturnValueOnce(pending.promise);
  const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={world.scope}>{children}</TaskCacheProvider>;
  const view = renderHook(() => useAttachments(project, task, transport), { wrapper });
  try {
    await waitFor(() => expect(view.result.current.complete).toBe(true));
    let write!: Promise<AttachmentWriteResult>; act(() => { write = view.result.current.put(a.path, new File(['old'], 'a.md')); });
    await waitFor(() => expect(transport.put).toHaveBeenCalledOnce());
    await admitTaskGraph(peer, graphFixture([target]), { epoch: original.epoch!, versionForTask: () => target.version, propertiesForTask: () => target.properties });
    const peerTicket = await peer.beginSync(project, peer.signal);
    await act(async () => { expect(await peer.revokeProject(peerTicket, peer.signal, true)).toBe(true); pending.resolve(a); });
    await waitFor(() => expect(view.result.current.confirmationPending).toBe(true));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(wireResponse(target, { headers: { 'Daynight-User-ID': world.scope.userId, 'Daynight-Task-Epoch': original.epoch! } }));
    await act(async () => { await view.result.current.checkConfirmation(); expect(await write).toBe('confirmed'); });
    expect(view.result.current.confirmedUnpublished).toBe(true);
    expect(fetch).toHaveBeenCalledOnce(); expect(transport.put).toHaveBeenCalledOnce();
    fetch.mockRestore();
  } finally { view.unmount(); peer.dispose(); world.dispose(); vi.unstubAllGlobals(); }
});
