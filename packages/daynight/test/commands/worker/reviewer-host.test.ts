import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), poll: vi.fn(), retained: vi.fn(), confirmed: vi.fn() }));
vi.mock("../../../src/commands/review/runtime.js", () => ({ runWorkerReview: mocks.run, hasRetainedWorkerReviewFailure: mocks.retained, isConfirmedWorkerReviewFailure: mocks.confirmed }));
vi.mock("../../../src/commands/worker/reviewer-source.js", () => ({ createReviewerSource: () => ({ source: { snapshot: () => ({ kind: "disabled" }) }, poll: mocks.poll }) }));
import { runReviewerHost } from "../../../src/commands/worker/reviewer-host.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const setup = async () => {
  mocks.retained.mockReturnValue(false);
  mocks.confirmed.mockReturnValue(false);
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/reviewer-host-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "reviewer-host-"));
  await mkdir(path.join(root, "reviewer")); await writeFile(path.join(root, "reviewer", "state.sqlite"), "");
  vi.stubEnv("DN_CONFIG_DIR", root);
  return root;
};
const options = (root: string, signal: AbortSignal) => ({ homeDirectory: root, packageDirectory: root, serverOrigin: "https://daynight.cc", serverToken: "fixture", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", signal, emit: vi.fn() });
it("retries retained recovery while participation stays disabled", async () => {
  const root = await setup();
  try {
    const controller = new AbortController(), input = options(root, controller.signal); let wake!: () => void;
    const waiting = new Promise<void>(resolve => { wake = resolve; });
    let entered!: () => void; const enteredWait = new Promise<void>(resolve => { entered = resolve; });
    mocks.poll.mockResolvedValue(undefined);
    mocks.run.mockRejectedValueOnce(new Error("temporary startup failure")).mockImplementationOnce((_paths, options) => {
      options.log({ level: "info", phase: "launch", message: "Starting.", repository: "github.com/example/repo", number: 7, reviewId: "review-id", revision: 2, attempt: 1 });
      return new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    let first = true;
    const job = runReviewerHost({ ...input, wait: async (_ms, signal) => {
      const stopped = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      if (first) { first = false; entered(); await Promise.race([waiting, stopped]); } else await stopped;
    } });
    await enteredWait; await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1)); wake();
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ phase: "launch", message: "github.com/example/repo PR 7 review=review-id revision=2 attempt=1 Starting." }));
    controller.abort(); await job;
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("reports and propagates an unconfirmed reviewer shutdown", async () => {
  const root = await setup();
  try {
    const controller = new AbortController(), input = options(root, controller.signal);
    mocks.poll.mockResolvedValue(undefined);
    mocks.run.mockImplementationOnce((_paths, options) => new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("process exclusion unconfirmed")), { once: true })));
    const job = runReviewerHost(input);
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1)); controller.abort();
    await expect(job).rejects.toThrow("process exclusion unconfirmed");
    expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ phase: "runtime", message: "Reviewer shutdown failed." }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps the first retained runtime closure when a later startup reports a different failure", async () => {
  const root = await setup();
  const controller = new AbortController(), input = options(root, controller.signal);
  const first = new Error("original native boundary unknown"), later = new Error("original lock remains held");
  const next = Promise.withResolvers<void>();
  let waits = 0;
  mocks.retained.mockImplementation(error => error === first);
  mocks.poll.mockResolvedValue(undefined);
  mocks.run.mockRejectedValueOnce(first).mockRejectedValueOnce(later);
  const job = runReviewerHost({ ...input, wait: async (_ms, signal) => {
    if (++waits === 1) await next.promise;
    else await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  } });
  try {
    await vi.waitFor(() => expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ error: first })));
    next.resolve();
    await vi.waitFor(() => expect(input.emit).toHaveBeenCalledWith(expect.objectContaining({ error: later })));
    controller.abort();
    await expect(job).rejects.toMatchObject({ errors: [first, later] });
  } finally { next.resolve(); controller.abort(); await Promise.allSettled([job]); await rm(root, { recursive: true, force: true }); }
});

it.each([true, false])("treats a wrapped cancellation as normal only with confirmed closure=%s", async confirmed => {
  const root = await setup(), controller = new AbortController(), input = options(root, controller.signal);
  const reason = new Error("stop original Reviewer"), receipt = new Error(reason.message, { cause: reason });
  mocks.confirmed.mockImplementation(error => error === receipt && confirmed);
  mocks.retained.mockImplementation(error => error === receipt && !confirmed);
  mocks.poll.mockResolvedValue(undefined);
  mocks.run.mockImplementationOnce((_paths, options) => new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(receipt), { once: true })));
  const job = runReviewerHost(input);
  try {
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(1));
    controller.abort(reason);
    if (confirmed) await expect(job).resolves.toBeUndefined();
    else await expect(job).rejects.toBe(receipt);
  } finally { controller.abort(reason); await Promise.allSettled([job]); await rm(root, { recursive: true, force: true }); }
});
