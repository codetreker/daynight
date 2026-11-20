import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn(), poll: vi.fn() }));
vi.mock("../../../src/commands/review/runtime.js", () => ({ runWorkerReview: mocks.run }));
vi.mock("../../../src/commands/worker/reviewer-source.js", () => ({ createReviewerSource: () => ({ source: { snapshot: () => ({ kind: "disabled" }) }, poll: mocks.poll }) }));
import { runReviewerHost } from "../../../src/commands/worker/reviewer-host.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const setup = async () => {
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
