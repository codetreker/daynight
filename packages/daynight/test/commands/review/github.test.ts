import path from "node:path";
import { pollRepositories, pollRepository } from "../../../src/commands/review/polling.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryConfiguration } from "../../../src/commands/review/config.js";
import {
  createGitHubClient, executeCommand, GitHubApiError,
  type CommandExecutor, type CommandOptions, type CommandResult, type GitHubRepository,
} from "../../../src/commands/review/adapters/github.js";
import { openStore, type Store } from "../../../src/commands/review/store.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";

const configuration: RepositoryConfiguration = {
  coordinate: "github.com/owner/repo", host: "github.com", owner: "owner", name: "repo",
  remote: "https://github.com/owner/repo.git", path: path.resolve("repo"),
};
const repository: GitHubRepository = { host: "github.com", githubId: "42", owner: "owner", name: "repo" };
const endpoint = (state = "open", page = 1, prefix = "repos/owner/repo"): string => `${prefix}/pulls?state=${state}&sort=created&direction=asc&per_page=100&page=${page}`;
const link = (state = "open", page = 2, prefix = "repositories/42", host = "https://api.github.com/"): string => `<${host}${endpoint(state, page, prefix)}>; rel="next"`;
const pr = (number: number, changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  number, state: "open", draft: false, merged_at: null, head: { sha: `head-${number}` }, base: { ref: "main", sha: "base-a" }, ...changes,
});
const suites = (nodes: unknown[] = [], cursor: string | null = null, totalCount = nodes.length): Record<string, unknown> => ({
  totalCount, nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
let suiteId = 0;
const suite = (changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `suite-${++suiteId}`, status: "COMPLETED", conclusion: "SUCCESS",
  workflowRun: { event: "pull_request", runNumber: 1, runAttempt: 1, workflow: { id: "workflow-1" } }, ...changes,
});
const checks = (changes: Record<string, unknown> = {}, headRollup: unknown = { state: "SUCCESS" }): Record<string, unknown> => ({
  data: { repository: { pullRequest: {
    state: "OPEN", isDraft: false, headRefOid: "head-11", baseRefName: "main",
    commits: { nodes: [{ commit: { oid: "head-11", statusCheckRollup: headRollup, checkSuites: suites() } }] },
    potentialMergeCommit: null, ...changes,
  } } },
});
const checksWithSuites = (head: unknown, merge: unknown = null, changes: Record<string, unknown> = {}): Record<string, unknown> => checks({
  commits: { nodes: [{ commit: { oid: "head-11", statusCheckRollup: { state: "SUCCESS" }, checkSuites: head } }] },
  potentialMergeCommit: merge === null ? null : { oid: "merge-11", statusCheckRollup: { state: "SUCCESS" }, checkSuites: merge }, ...changes,
});
const workflowRun = (runNumber: number, runAttempt = 1, id = "workflow-1", event = "pull_request"): Record<string, unknown> => ({
  event, runNumber, runAttempt, workflow: { id },
});
const rawResponse = (body: string, headers: Record<string, string> = {}, status = 200, error: Error | null = null): CommandResult => ({
  stdout: `HTTP/2.0 ${status} Status\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n${body}`,
  stderr: "", error,
});
const response = (body: unknown, headers: Record<string, string> = {}, status = 200, error: Error | null = null): CommandResult =>
  rawResponse(`${JSON.stringify(body)}`, headers, status, error);
const exitError = (code: number | string, other: Record<string, unknown> = {}): Error => Object.assign(new Error("CLI failure"), { code, ...other });
const queue = (...responses: (CommandResult | Error)[]) => {
  const calls: { file: string; args: readonly string[]; options: CommandOptions }[] = [];
  const execute: CommandExecutor = async (file, args, options) => {
    calls.push({ file, args, options });
    const next = responses.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${args.at(-1)}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, execute, client: createGitHubClient({ execute, now: () => 100_000 }), remaining: () => responses.length };
};
const fixtureRoot = path.resolve(import.meta.dirname, "../../../../../.tmp/github-tests");
const fixtures: { directory: string; store: Store }[] = [];
const fixture = () => {
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(path.join(fixtureRoot, "GitHub 状态 "));
  const store = openStore(createMemoryDatabase());
  fixtures.push({ directory, store });
  const initialize = (cutoff = 10) => {
    store.registerRepository({ ...repository, remote: configuration.remote, localPath: configuration.path });
    store.initializeRepository(repository, cutoff, 1);
    store.recordPollSuccess(repository, 2);
  };
  const observe = (number: number, changes: Record<string, unknown> = {}) => store.observePullRequest(repository, {
    number, state: "open", draft: false, headSha: `head-${number}`, baseRef: "main", baseSha: "base-a", ...changes,
  }, 3);
  const poll = (client: ReturnType<typeof createGitHubClient>) => pollRepository(store, configuration, client, { now: () => 200_000 });
  return { store, directory, initialize, observe, poll };
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { directory, store } of fixtures.splice(0)) { store.close(); rmSync(directory, { recursive: true }); }
});

describe("read-only GitHub CLI transport", () => {
  it("uses explicit GET, host, version and accept headers with bounded capture and argument arrays", async () => {
    const { client, calls } = queue(response({ id: 42 }));
    const signal = new AbortController().signal;
    expect(await client.resolveRepository(configuration, signal)).toEqual(repository);
    expect(calls).toEqual([{
      file: "gh", args: ["api", "--include", "--method", "GET", "--hostname", "github.com", "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28", "repos/owner/repo"],
      options: { timeoutMs: 30_000, maxBufferBytes: 16 * 1024 * 1024, signal },
    }]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "42", null, undefined])("rejects unstable or invalid repository REST identity %s", async (id) => {
    const { client } = queue(response({ id, node_id: "opaque-node-id" }));
    await expect(client.resolveRepository(configuration)).rejects.toThrow("repository ID");
  });

  it("preserves host qualification for equal REST IDs", async () => {
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "fake-prepared-enterprise-token");
    const target = { ...configuration, host: "git.example:8443" };
    const { client, calls } = queue(response({ id: 42 }));
    expect(await client.resolveRepository(target)).toEqual({ ...repository, host: target.host });
    expect(calls[0]!.args).toContain("git.example");
    expect(calls[0]!.args.at(-1)).toBe("https://git.example:8443/api/v3/repos/owner/repo");
  });

  it.each([
    ["401 Unauthorized", 401, {}], ["403 Forbidden", 403, {}], ["404 Not Found", 404, {}],
  ])("exposes %s without retrying", async (_label, status, headers) => {
    const cause = exitError(1);
    const { client, calls } = queue(response({ message: "Denied" }, headers, status, cause));
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ name: "GitHubApiError", status, retryAt: null, cause });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "700" }, {}, 700_000],
    [429, { "Retry-After": "300" }, {}, 400_000],
    [403, { "Retry-After": new Date(500_000).toUTCString() }, {}, 500_000],
    [403, { "Retry-After": "100", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "900" }, {}, 900_000],
    [403, {}, { message: "You have exceeded a secondary rate limit" }, 160_000],
    [429, {}, {}, 160_000],
  ])("returns the latest server rate-limit deadline for HTTP %s", async (status, headers, body, retryAt) => {
    const { client, calls } = queue(response(body, headers, status, exitError(1)));
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status, retryAt });
    expect(calls).toHaveLength(1);
  });

  it("does not discard the HTTP failure when retry metadata is malformed", async () => {
    const cause = exitError(1);
    const { client } = queue(response({}, { "Retry-After": "not-a-date" }, 429, cause));
    const error = await client.resolveRepository(configuration).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 429, cause: expect.any(AggregateError) });
    expect((error as GitHubApiError).cause).toMatchObject({ errors: [cause, expect.any(Error)] });
  });

  it.each([
    exitError("ENOENT"), exitError("ABORT_ERR"), exitError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"),
    exitError(1, { killed: true }), exitError(1, { signal: "SIGTERM" }), new Error("unknown process failure"),
  ])("rejects abnormal capture even when partial stdout contains valid HTTP JSON", async (cause) => {
    const { client } = queue(response({ id: 42 }, {}, 200, cause));
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status: null, cause });
  });

  it("rejects an aborted request even if an executor reports complete success", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled"));
    const { client } = queue(response({ id: 42 }));
    await expect(client.resolveRepository(configuration, controller.signal)).rejects.toMatchObject({ status: null, cause: controller.signal.reason });
  });

  it("retains thrown executor errors", async () => {
    const cause = new Error("spawn failed");
    const { client } = queue(cause);
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ cause });
  });

  it.each(["{}", "HTTP/2.0 200 OK\n{\"id\":42}", "HTTP/2.0 200 OK\nInvalidHeader\n\n{}", "HTTP/2.0 200 OK\n\n{", "HTTP/2.0 200 OK\n\n{}\ntrailing"]) ("rejects incomplete or malformed framing %s", async (stdout) => {
    const { client } = queue({ stdout, stderr: "", error: null });
    await expect(client.resolveRepository(configuration)).rejects.toThrow("Cannot parse GitHub response");
  });

  it("preserves numeric process failure alongside malformed HTTP output", async () => {
    const cause = exitError(1);
    const { client } = queue({ stdout: "not HTTP", stderr: "failure", error: cause });
    const error = await client.resolveRepository(configuration).catch((value: unknown) => value);
    expect(error).toMatchObject({ cause: expect.any(AggregateError) });
    expect((error as GitHubApiError).cause).toMatchObject({ errors: [cause, expect.any(Error)] });
  });

  it("rejects a numeric process failure after an HTTP success", async () => {
    const cause = exitError(1);
    const { client } = queue(response({ id: 42 }, {}, 200, cause));
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status: null, cause });
  });

  it.each([{ timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { maxBufferBytes: 0 }])("rejects invalid transport bounds %s", (options) => {
    expect(() => createGitHubClient(options)).toThrow();
  });
});

describe("current PR CI readiness", () => {
  it("reads HEAD and potential merge aggregates in one bounded read-only GraphQL POST", async () => {
    const { client, calls } = queue(response(checks({ potentialMergeCommit: { oid: "merge-11", statusCheckRollup: { state: "SUCCESS" }, checkSuites: suites() } })));
    const signal = new AbortController().signal;
    expect(await client.getPullRequestChecks(repository, 11, signal)).toEqual({ headSha: "head-11", baseRef: "main", ready: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe("gh");
    expect(call.args).toEqual([
      "api", "--include", "--method", "POST", "--hostname", "github.com",
      "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28",
      "--raw-field", expect.stringContaining("query=query PullRequestChecks($owner: String!, $name: String!, $number: Int!, $headCursor: String, $mergeCursor: String)"),
      "--raw-field", "owner=owner", "--raw-field", "name=repo", "--field", "number=11", "--field", "headCursor=null", "--field", "mergeCursor=null", "graphql",
    ]);
    expect(call.args.join("\n")).toContain("commits(last: 1) { nodes { commit {");
    expect(call.args.join("\n")).toContain("checkSuites(first: 100, after: $headCursor)");
    expect(call.args.join("\n")).toContain("checkSuites(first: 100, after: $mergeCursor)");
    expect(call.args.join("\n")).not.toContain("mutation");
    expect(call.options).toEqual({ timeoutMs: 30_000, maxBufferBytes: 16 * 1024 * 1024, signal });
  });

  it("allows successful, skipped and neutral checks represented by GitHub's SUCCESS aggregate", async () => {
    const { client } = queue(response(checks()));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: true });
  });

  it.each(["ERROR", "EXPECTED", "FAILURE", "PENDING"])("waits while the HEAD aggregate is %s", async (state) => {
    const { client } = queue(response(checks({}, { state })));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it.each(["ERROR", "EXPECTED", "FAILURE", "PENDING"])("waits while test-merge CI is %s even after HEAD passes", async (state) => {
    const { client } = queue(response(checks({ potentialMergeCommit: { oid: "merge-11", statusCheckRollup: { state }, checkSuites: suites() } })));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it("allows a PR with no checks on either current commit", async () => {
    const { client } = queue(response(checks({ potentialMergeCommit: { oid: "merge-11", statusCheckRollup: null, checkSuites: suites() } }, null)));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: true });
  });

  it.each(["ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "FAILURE", "STARTUP_FAILURE", "STALE", null])("blocks a registered jobless suite concluding %s despite a green aggregate", async (conclusion) => {
    const { client } = queue(response(checksWithSuites(suites([suite({ conclusion })]))));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it.each(["REQUESTED", "QUEUED", "IN_PROGRESS", "WAITING", "PENDING"])("blocks a registered jobless suite still %s", async (status) => {
    const { client } = queue(response(checksWithSuites(suites([suite({ status, conclusion: null })]))));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it.each(["SUCCESS", "SKIPPED", "NEUTRAL"])("accepts a completed suite concluding %s", async (conclusion) => {
    const { client } = queue(response(checksWithSuites(suites([suite({ conclusion })]))));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: true });
  });

  it("ignores superseded failed workflow executions and rerun attempts regardless of page order", async () => {
    const oldRun = suite({ conclusion: "FAILURE", workflowRun: workflowRun(1) });
    const oldAttempt = suite({ conclusion: "ACTION_REQUIRED", workflowRun: workflowRun(2, 1) });
    const current = suite({ workflowRun: workflowRun(2, 2) });
    const { client } = queue(response(checksWithSuites(suites([oldRun, current], "head-page-2", 3))), response(checksWithSuites(suites([oldAttempt], null, 3))));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: true });
  });

  it.each([
    workflowRun(2, 1, "other-workflow"), workflowRun(2, 1, "workflow-1", "push"), workflowRun(3),
  ])("keeps a different or newer failed workflow execution blocking: %s", async (run) => {
    const { client } = queue(response(checksWithSuites(suites([suite({ workflowRun: workflowRun(2) }), suite({ conclusion: "ACTION_REQUIRED", workflowRun: run })]))));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it("does not discard failures without a workflow replacement identity", async () => {
    const { client } = queue(response(checksWithSuites(suites([
      suite({ conclusion: "FAILURE", workflowRun: null }), suite({ workflowRun: null }),
    ]))));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it("keeps contradictory summaries for the same latest workflow attempt blocking", async () => {
    const { client } = queue(response(checksWithSuites(suites([suite(), suite({ conclusion: "FAILURE" })]))));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it("reads independent HEAD and merge-suite pages before allowing review", async () => {
    const headFirst = suite(); const headLast = suite({ workflowRun: workflowRun(2) });
    const mergeFirst = suite(); const mergeMiddle = suite({ conclusion: "ACTION_REQUIRED", workflowRun: workflowRun(2) });
    const mergeLast = suite({ workflowRun: workflowRun(3) });
    const { client, calls } = queue(
      response(checksWithSuites(suites([headFirst], "head-next", 2), suites([mergeFirst], "merge-next", 3))),
      response(checksWithSuites(suites([headLast], null, 2), suites([mergeMiddle], "merge-last", 3))),
      response(checksWithSuites(suites([headLast], null, 2), suites([mergeLast], null, 3))),
    );
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: true });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.args).toContain("headCursor=head-next");
    expect(calls[1]!.args).toContain("mergeCursor=merge-next");
    expect(calls[2]!.args).toContain("mergeCursor=merge-last");
  });

  it("blocks when a later merge-suite page contains the latest failed workflow", async () => {
    const { client } = queue(
      response(checksWithSuites(suites(), suites([suite()], "next", 2))),
      response(checksWithSuites(suites(), suites([suite({ conclusion: "FAILURE", workflowRun: workflowRun(2) })], null, 2))),
    );
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it.each(["head", "merge"])("keeps refreshed blockers from the completed %s side while paging the other side", async (completedSide) => {
    const initialSuite = suite();
    const passed = suites([initialSuite]);
    const waiting = suites([suite({ id: initialSuite.id, status: "WAITING", conclusion: null, workflowRun: workflowRun(1, 2) })]);
    const paging = suites([suite()], "next", 2);
    const last = suites([suite()], null, 2);
    const initial = completedSide === "head" ? checksWithSuites(passed, paging) : checksWithSuites(paging, passed);
    const refreshed = completedSide === "head" ? checksWithSuites(waiting, last) : checksWithSuites(last, waiting);
    const { client, calls } = queue(response(initial), response(refreshed));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
    expect(calls).toHaveLength(2);
  });

  it.each(["head", "merge"])("rejects growth beyond the completed %s collection while the other side finishes", async (completedSide) => {
    const initialSuite = suite();
    const passed = suites([initialSuite]);
    const grown = suites([initialSuite], "unread-page", 2);
    const paging = suites([suite()], "next", 2);
    const last = suites([suite()], null, 2);
    const initial = completedSide === "head" ? checksWithSuites(passed, paging) : checksWithSuites(paging, passed);
    const refreshed = completedSide === "head" ? checksWithSuites(grown, last) : checksWithSuites(last, grown);
    const { client, calls } = queue(response(initial), response(refreshed));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow("count changed");
    expect(calls).toHaveLength(2);
  });

  it("retains a completed multi-page collection when a stable earlier page is refreshed", async () => {
    const headFirst = Array.from({ length: 100 }, () => suite());
    const headLast = suite();
    const { client, calls } = queue(
      response(checksWithSuites(suites(headFirst, "head-next", 101), suites([suite()], "merge-next", 3))),
      response(checksWithSuites(suites([headLast], null, 101), suites([suite()], "merge-last", 3))),
      response(checksWithSuites(suites(headFirst, "head-next", 101), suites([suite()], null, 3))),
    );
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: true });
    expect(calls).toHaveLength(3);
  });

  it("rejects observable membership replacement in an already completed collection", async () => {
    const { client } = queue(
      response(checksWithSuites(suites([suite()]), suites([suite()], "merge-next", 2))),
      response(checksWithSuites(suites([suite()]), suites([suite()], null, 2))),
    );
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow("membership changed");
  });

  it.each([undefined, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1])("rejects invalid collection totalCount %s", async (totalCount) => {
    const { client } = queue(response(checksWithSuites({ ...suites(), totalCount })));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow("check-suite count");
  });

  it("requires unique collected IDs to cover the advertised totalCount", async () => {
    const first = suite();
    const { client } = queue(
      response(checksWithSuites(suites([first], "next", 2))),
      response(checksWithSuites(suites([first], null, 2))),
    );
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow("repeated a check-suite ID");
    const incomplete = queue(response(checksWithSuites(suites([suite()], null, 2))));
    await expect(incomplete.client.getPullRequestChecks(repository, 11)).rejects.toThrow("incomplete check-suite collection");
  });

  it.each([
    response({}, {}, 503, exitError(1)), response({ errors: [{ type: "INTERNAL", message: "Partial" }] }),
    response(checksWithSuites(suites(), null, { baseRefName: "release" })),
    response(checksWithSuites(suites(), suites())),
    response(checksWithSuites(suites([suite()], "next", 2))),
  ])("never approves after a failed, changed or cycling later CI page %s", async (later) => {
    const { client } = queue(response(checksWithSuites(suites([suite()], "next", 2))), later);
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow();
  });

  it("rejects a new matching head snapshot observed during check-suite pagination", async () => {
    const next = checksWithSuites(suites(), null, {
      headRefOid: "new-head", commits: { nodes: [{ commit: { oid: "new-head", statusCheckRollup: { state: "SUCCESS" }, checkSuites: suites() } }] },
    });
    const { client } = queue(response(checksWithSuites(suites([suite()], "next", 2))), response(next));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow("target changed");
  });

  it.each([
    null, {}, { totalCount: 1, nodes: [], pageInfo: { hasNextPage: true, endCursor: "next" } },
    { totalCount: 1, nodes: [suite()], pageInfo: { hasNextPage: true, endCursor: null } },
    { totalCount: 1, nodes: [suite()], pageInfo: { hasNextPage: false } },
    suites([suite({ status: "UNKNOWN" })]), suites([suite({ conclusion: "UNKNOWN" })]),
    suites([suite({ id: undefined })]), suites([suite({ workflowRun: undefined })]),
    suites([suite({ workflowRun: workflowRun(0) })]), suites([suite({ workflowRun: workflowRun(1, 0) })]),
  ])("fails closed for an invalid registered-suite response %s", async (page) => {
    const { client } = queue(response(checksWithSuites(page)));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow();
  });

  it.each([{ state: "CLOSED" }, { state: "MERGED" }, { isDraft: true }])("excludes a PR that is no longer ready for review: %s", async (changes) => {
    const { client } = queue(response(checks(changes)));
    expect(await client.getPullRequestChecks(repository, 11)).toMatchObject({ ready: false });
  });

  it.each([
    {}, { data: null }, { data: { repository: null } }, { data: { repository: { pullRequest: null } } },
    checks({ state: "invalid" }), checks({ isDraft: "false" }), checks({ headRefOid: "" }), checks({ baseRefName: null }),
    checks({ commits: { nodes: [] } }), checks({ commits: { nodes: [null] } }),
    checks({ commits: { nodes: [{ commit: { oid: "other-head", statusCheckRollup: null } }] } }),
    checks({ commits: { nodes: [{ commit: { oid: "head-11" } }] } }),
    checks({ potentialMergeCommit: undefined }), checks({ potentialMergeCommit: { statusCheckRollup: null } }),
    checks({ potentialMergeCommit: { oid: "merge-11", statusCheckRollup: {} } }),
    checks({}, { state: "SKIPPED" }), checks({}, { state: "CANCELLED" }), checks({}, { state: undefined }),
    { ...checks(), errors: null }, { ...checks(), errors: [{ type: "FORBIDDEN", message: "Denied" }] },
    { ...checks(), errors: [null] },
  ])("fails closed for malformed or rejected CI observations %s", async (body) => {
    const { client } = queue(response(body));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toThrow();
  });

  it("retains strict output capture for a GraphQL response", async () => {
    const { client } = queue(response(checks(), {}, 200, exitError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toMatchObject({ status: null, cause: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } });
  });

  it.each([undefined, 0, -1, 1.5])("rejects an invalid PR number %s before a request", async (number) => {
    const { client, calls } = queue();
    await expect(client.getPullRequestChecks(repository, number as number)).rejects.toThrow("PR number");
    expect(calls).toHaveLength(0);
  });

  it("shares HTTP-200 GraphQL RATE_LIMITED cooldowns with REST requests", async () => {
    const { client, calls } = queue(response({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, { "Retry-After": "100", "X-RateLimit-Reset": "900" }, 200, exitError(1)));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toMatchObject({ status: 200, retryAt: 900_000, cause: { code: 1 } });
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status: 200, retryAt: 900_000 });
    await expect(client.getPullRequestChecks(repository, 12)).rejects.toMatchObject({ retryAt: 900_000 });
    expect(calls).toHaveLength(1);
  });

  it("uses the normal minimum cooldown when GraphQL supplies no rate-limit deadline", async () => {
    const { client } = queue(response({ errors: [{ type: "RATE_LIMITED", message: "Limited" }] }));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toMatchObject({ status: 200, retryAt: 160_000 });
  });

  it("retains GraphQL process failure when rate-limit metadata is malformed", async () => {
    const cause = exitError(1);
    const { client } = queue(response({ errors: [{ type: "RATE_LIMITED", message: "Limited" }] }, { "X-RateLimit-Reset": "invalid" }, 200, cause));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toMatchObject({ status: 200, cause: { errors: [cause, expect.any(Error)] } });
  });

  it("does not infer readiness from partial data accompanying GraphQL errors", async () => {
    const { client } = queue(response({ ...checks(), errors: [{ type: "INTERNAL", message: "Partial result" }] }, {}, 200, exitError(1)));
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toMatchObject({ status: 200, retryAt: null, cause: { code: 1 } });
  });
});

describe("complete PR scans", () => {
  it("reads every all-state page using numeric repository pagination and coalesces repeated PRs", async () => {
    const { client, calls } = queue(response([{ number: 30 }, { number: 4 }], { Link: link("all") }), response([{ number: 30 }, { number: 70 }]));
    expect(await client.listPullRequestNumbers(repository)).toEqual([30, 4, 70]);
    expect(calls.map((call) => call.args.at(-1))).toEqual([endpoint("all"), endpoint("all", 2, "repositories/42")]);
  });

  it("accepts an empty complete scan and original coordinate pagination", async () => {
    const { client } = queue(response([], { Link: link("all", 2, "repos/owner/repo") }), response([]));
    expect(await client.listPullRequestNumbers(repository)).toEqual([]);
  });

  it.each([
    ["git.example:8443", "https://git.example:8443/api/v3/"],
    ["tenant.ghe.com", "https://api.tenant.ghe.com/"],
    ["tenant.ghe.com:8443", "https://tenant.ghe.com:8443/api/v3/"],
    ["github.com:8443", "https://github.com:8443/api/v3/"],
  ])("uses the expected API prefix for %s", async (host, base) => {
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "fake-prepared-enterprise-token");
    const { client, calls } = queue(response([{ number: 10 }], { Link: link("all", 2, "repositories/42", base) }), response([]));
    expect(await client.listPullRequestNumbers({ ...repository, host })).toEqual([10]);
    expect(calls[1]!.args.at(-1)).toBe(host.includes(":") ? `${base}${endpoint("all", 2, "repositories/42")}` : endpoint("all", 2, "repositories/42"));
  });

  it("permanently ignores cutoff PR metadata before normalization and lets the last repeated PR win", async () => {
    const { client } = queue(response([{ number: 10 }, pr(11)], { Link: link() }), response([pr(11, { head: { sha: "newest" }, draft: true })]));
    expect(await client.listOpenPullRequests(repository, 10)).toEqual([{ number: 11, state: "open", draft: true, headSha: "newest", baseRef: "main", baseSha: "base-a" }]);
  });

  it.each([
    "<https://evil.test/repositories/42/pulls?state=open&sort=created&direction=asc&per_page=100&page=2>; rel=next",
    link().replace("https://", "http://"), link().replace("https://", "https://token@"), `${link().replace(">", "#fragment>")}`,
    link().replace("repositories/42", "repositories/99"), link().replace("pulls?", "issues?"),
    link().replace("state=open", "state=all"), link().replace("sort=created", "sort=updated"),
    link().replace("per_page=100", "per_page=10"), link().replace("page=2", "page=1"),
    link().replace("page=2", "page=0"), link().replace("page=2", "page=2&page=3"),
    link().replace("page=2", "page=2&since=now"), link().replace("state=open", "state=open&state=open"),
    "not a Link", `${link()}, ${link()}`,
  ])("rejects an unsafe or non-progressing pagination link %s", async (header) => {
    const { client, calls } = queue(response([], { Link: header }));
    await expect(client.listOpenPullRequests(repository, 10)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("rejects a later pagination cycle without issuing another request", async () => {
    const { client, calls } = queue(response([], { Link: link() }), response([], { Link: link("open", 1) }));
    await expect(client.listOpenPullRequests(repository, 10)).rejects.toThrow("advance");
    expect(calls).toHaveLength(2);
  });

  it.each([
    {}, [{ number: 0 }], [pr(11, { draft: "false" })], [pr(11, { head: null })], [pr(11, { base: { ref: "main" } })],
    [pr(11, { merged_at: undefined })], [pr(11, { state: "closed" })], [pr(11, { merged_at: "yesterday" })],
  ])("rejects invalid list data %s", async (body) => {
    const { client } = queue(response(body));
    await expect(client.listOpenPullRequests(repository, 10)).rejects.toThrow();
  });

  it.each([
    [pr(11), "open"], [pr(11, { state: "closed" }), "closed"],
    [pr(11, { state: "closed", merged: true, merged_at: "2026-10-17T00:00:00Z" }), "merged"],
  ])("normalizes confirmed PR lifecycle state %s", async (body, state) => {
    const { client } = queue(response(body));
    expect(await client.getPullRequest(repository, 11)).toMatchObject({ number: 11, state });
  });

  it("rejects a single-PR response for the wrong number", async () => {
    const { client } = queue(response(pr(12)));
    await expect(client.getPullRequest(repository, 11)).rejects.toThrow("different PR");
  });
});

describe("durable repository observations", () => {
  it("commits a permanent maximum across all states only after every initial page succeeds", async () => {
    const { store, poll } = fixture();
    const { client, calls } = queue(response({ id: 42 }), response([{ number: 30 }], { Link: link("all") }), response([{ number: 70 }, { number: 2 }]));
    expect(await poll(client)).toMatchObject({ startPrNumber: 70, initializedAt: 200_000, lastPollAt: 200_000, lastPollError: null });
    expect(store.listPullRequests(repository)).toEqual([]);
    expect(calls[1]!.args.at(-1)).toContain("state=all");
    const next = queue(response({ id: 42 }), response([pr(40), pr(71)]));
    expect(await poll(next.client)).toMatchObject({ startPrNumber: 70, initializedAt: 200_000 });
    expect(store.listPullRequests(repository).map((item) => item.number)).toEqual([71]);
    expect(next.calls[1]!.args.at(-1)).toContain("state=open");
  });

  it("commits zero only for a genuinely empty complete initial scan", async () => {
    const { store, poll } = fixture();
    const { client } = queue(response({ id: 42 }), response([]));
    expect(await poll(client)).toMatchObject({ startPrNumber: 0 });
    expect(store.getRepository(repository)?.lastPollAt).toBe(200_000);
  });

  it("leaves initial cutoff null and records the error when a later page fails", async () => {
    const { store, poll } = fixture();
    const { client } = queue(response({ id: 42 }), response([{ number: 70 }], { Link: link("all") }), response({}, {}, 500, exitError(1)));
    await expect(poll(client)).rejects.toMatchObject({ status: 500 });
    expect(store.getRepository(repository)).toMatchObject({ startPrNumber: null, initializedAt: null, lastPollAt: null, lastPollError: expect.stringContaining("HTTP 500") });
    const retry = queue(response({ id: 42 }), response([{ number: 80 }]));
    expect(await poll(retry.client)).toMatchObject({ startPrNumber: 80 });
  });

  it("applies existing trigger rules including old PR changes and only makes ready PRs candidates", async () => {
    const { store, initialize, poll } = fixture();
    initialize();
    await poll(queue(response({ id: 42 }), response([pr(11, { draft: true }), pr(20)])).client);
    expect(store.listCandidates(200_000).map((item) => item.pullRequest.number)).toEqual([20]);
    await poll(queue(response({ id: 42 }), response([pr(11), pr(20, { base: { ref: "main", sha: "base-new" } })])).client);
    expect(store.getPullRequest({ ...repository, number: 11 })?.desiredRevision).toBe(2);
    expect(store.getPullRequest({ ...repository, number: 20 })?.desiredRevision).toBe(1);
    await poll(queue(response({ id: 42 }), response([pr(11, { head: { sha: "force-pushed" } }), pr(20, { base: { ref: "release", sha: "base-new" } })])).client);
    expect(store.getPullRequest({ ...repository, number: 11 })?.desiredRevision).toBe(3);
    expect(store.getPullRequest({ ...repository, number: 20 })?.desiredRevision).toBe(2);
  });

  it("confirms missing tracked-open PRs, retaining still-open and marking closed/merged cleanup", async () => {
    const { store, initialize, observe, poll, directory } = fixture();
    initialize();
    for (const number of [11, 12, 13]) {
      observe(number);
      store.registerWorktree({ ...repository, number }, path.join(directory, ".worktrees", `pr-${number}`));
    }
    const { client, calls } = queue(response({ id: 42 }), response([]), response(pr(11)), response(pr(12, { state: "closed", merged: false })), response(pr(13, { state: "closed", merged: true, merged_at: "2026-10-17T00:00:00Z" })));
    await poll(client);
    expect(calls.slice(2).map((item) => item.args.at(-1))).toEqual(["repos/owner/repo/pulls/11", "repos/owner/repo/pulls/12", "repos/owner/repo/pulls/13"]);
    expect(store.listPullRequests(repository).map((item) => [item.number, item.state, item.cleanupPending])).toEqual([[11, "open", false], [12, "closed", true], [13, "merged", true]]);
    expect(store.listCleanupCandidates().map((item) => item.number)).toEqual([12, 13]);
    await poll(queue(response({ id: 42 }), response([pr(11), pr(12), pr(13)])).client);
    expect(store.listPullRequests(repository).map((item) => [item.number, item.state, item.cleanupPending])).toEqual([[11, "open", false], [12, "open", true], [13, "open", true]]);
    expect(store.listCleanupCandidates().map((item) => item.number)).toEqual([12, 13]);
    expect(store.listCandidates(200_000).map((item) => item.pullRequest.number)).toEqual([11]);
    expect(store.getPullRequest({ ...repository, number: 12 })?.desiredRevision).toBe(2);
  });

  it.each(["later-page", "malformed-pr", "confirmation-404", "confirmation-malformed"]) ("preserves every prior PR state and success time on %s failure", async (mode) => {
    const { store, initialize, observe, poll } = fixture();
    initialize(); observe(11); observe(12);
    const before = store.listPullRequests(repository);
    const pages = mode === "later-page" ? [response([pr(11, { head: { sha: "new" } })], { Link: link() }), response({}, {}, 503, exitError(1))]
      : mode === "malformed-pr" ? [response([pr(11, { head: { sha: "new" } }), { number: 13 }])]
        : mode === "confirmation-404" ? [response([pr(11, { head: { sha: "new" } })]), response({}, {}, 404, exitError(1))]
          : [response([pr(11, { head: { sha: "new" } })]), response(pr(12, { head: null }))];
    await expect(poll(queue(response({ id: 42 }), ...pages).client)).rejects.toThrow();
    expect(store.listPullRequests(repository)).toEqual(before);
    expect(store.getRepository(repository)).toMatchObject({ lastPollAt: 2, lastPollError: expect.any(String) });
  });

  it("converges after moving pages temporarily omit an untracked PR without using a permanent cursor", async () => {
    const { store, initialize, poll } = fixture(); initialize();
    await poll(queue(response({ id: 42 }), response([pr(11)], { Link: link() }), response([pr(11), pr(13)])).client);
    expect(store.listPullRequests(repository).map((item) => item.number)).toEqual([11, 13]);
    await poll(queue(response({ id: 42 }), response([pr(11), pr(12), pr(13)])).client);
    expect(store.listPullRequests(repository).map((item) => item.number)).toEqual([11, 12, 13]);
  });

  it("isolates failed repositories while returning their visible error results", async () => {
    const { store } = fixture();
    const second = { ...configuration, coordinate: "git.example/owner/second", host: "git.example", name: "second", path: path.resolve("second") };
    const { client, calls } = queue(response({ id: 42 }), response({}, {}, 429, exitError(1)), response({ id: 43 }), response([]));
    const results = await pollRepositories(store, [configuration, second], client, { now: () => 200_000 });
    expect(results).toMatchObject([{ configuration, ok: false, error: { status: 429, retryAt: 160_000 } }, { configuration: second, ok: true, repository: { githubId: "43", startPrNumber: 0 } }]);
    expect(calls).toHaveLength(4);
    expect(store.getRepository(repository)?.startPrNumber).toBeNull();
    expect(store.getRepository({ host: "git.example", githubId: "43" })?.startPrNumber).toBe(0);
  });

  it("preserves both the polling error and failure to persist it", async () => {
    const { store, poll } = fixture();
    const failure = new Error("Request failed");
    const persistenceFailure = new Error("SQLite unavailable");
    const original = store.recordPollError;
    store.recordPollError = () => { throw persistenceFailure; };
    try {
      const error = await poll(queue(response({ id: 42 }), failure).client).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([expect.objectContaining({ cause: failure }), persistenceFailure]);
    } finally { store.recordPollError = original; }
  });
});

describe("native child process capture", () => {
  it("removes inherited repository selectors only from the command environment", async () => {
    vi.stubEnv("GIT_DIR", "unrelated-repository");
    vi.stubEnv("GIT_INDEX_FILE", "unrelated-index");
    const result = await executeCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.GIT_DIR === undefined, process.env.GIT_INDEX_FILE === undefined]))"], {
      timeoutMs: 5_000,
      maxBufferBytes: 1_024,
      environment: { GIT_DIR: undefined, GIT_INDEX_FILE: undefined },
    });
    expect(result.error).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual([true, true]);
    expect(process.env.GIT_DIR).toBe("unrelated-repository");
    expect(process.env.GIT_INDEX_FILE).toBe("unrelated-index");
  });

  const script = path.join(import.meta.dirname, "../../fixtures", "gh-api.mjs");
  const nativeClient = (mode: string, bounds: { timeoutMs?: number; maxBufferBytes?: number } = {}) => createGitHubClient({
    ...bounds, execute: (_file, _args, options) => executeCommand(process.execPath, [script, mode], options),
  });

  it("accepts actual mixed-newline HTTP output without a trailing newline", async () => {
    expect(await nativeClient("success").resolveRepository(configuration)).toEqual(repository);
  });

  it("retains actual HTTP failure stdout from a numeric nonzero exit", async () => {
    await expect(nativeClient("not-found").resolveRepository(configuration)).rejects.toMatchObject({ status: 404, cause: { code: 1 } });
  });

  it.each(["non-http", "failed-success"]) ("rejects actual failed process output %s", async (mode) => {
    await expect(nativeClient(mode).resolveRepository(configuration)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("rejects buffer truncation even after a complete-looking response prefix", async () => {
    await expect(nativeClient("overflow", { maxBufferBytes: 1024 }).resolveRepository(configuration)).rejects.toMatchObject({ status: null, cause: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } });
  });

  it("rejects timeout even after a complete-looking response prefix", async () => {
    await expect(nativeClient("wait", { timeoutMs: 300 }).resolveRepository(configuration)).rejects.toMatchObject({ status: null, cause: { killed: true } });
  });

  it("rejects cancellation and waits for the native command callback", async () => {
    const controller = new AbortController();
    const pending = nativeClient("wait").resolveRepository(configuration, controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toMatchObject({ status: null, cause: { code: "ABORT_ERR" } });
  });
});

describe("prepared authentication for repositories with API ports", () => {
  const target = { ...configuration, coordinate: "git.example:8443/owner/repo", host: "git.example:8443" };
  const fakeToken = "fake-port-credential-DO-NOT-EXPOSE";
  const noEnterpriseEnvironment = (): void => {
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "");
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "");
  };
  const credential = (error: Error | null = null): CommandResult => ({ stdout: `${fakeToken}\n`, stderr: "", error });
  const errorText = (error: unknown): string => {
    if (!(error instanceof Error)) return JSON.stringify(error);
    const own = JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(error).map((key) => [key, (error as unknown as Record<string, unknown>)[key]])));
    return `${own} ${error.cause === undefined ? "" : errorText(error.cause)} ${error instanceof AggregateError ? error.errors.map(errorText).join(" ") : ""}`;
  };

  it("obtains prepared bare-host authentication privately and passes it only in the API child environment", async () => {
    noEnterpriseEnvironment();
    const { client, calls } = queue(credential(), response({ id: 42 }));
    expect(await client.resolveRepository(target)).toMatchObject({ host: target.host, githubId: "42" });
    expect(calls[0]!.args).toEqual(["auth", "token", "--hostname", "git.example"]);
    expect(calls[0]!.options).toEqual({ timeoutMs: 30_000, maxBufferBytes: 16 * 1024 * 1024 });
    expect(calls[1]!.args.at(-1)).toBe("https://git.example:8443/api/v3/repos/owner/repo");
    expect(calls[1]!.args).toContain("git.example");
    expect(calls[1]!.options.environment).toEqual({ GH_ENTERPRISE_TOKEN: fakeToken });
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(fakeToken);
    expect(process.env.GH_ENTERPRISE_TOKEN).toBe("");
  });

  it("uses the GraphQL port route and the same private bare-host authentication bridge", async () => {
    noEnterpriseEnvironment();
    const { client, calls } = queue(credential(), response(checks()));
    expect(await client.getPullRequestChecks({ ...repository, host: target.host }, 11)).toMatchObject({ ready: true });
    expect(calls[0]!.args).toEqual(["auth", "token", "--hostname", "git.example"]);
    expect(calls[1]!.args.at(-1)).toBe("https://git.example:8443/api/graphql");
    expect(calls[1]!.args).toContain("git.example");
    expect(calls[1]!.args).toContain("variables[owner]=owner");
    expect(calls[1]!.args).toContain("variables[name]=repo");
    expect(calls[1]!.args).toContain("variables[number]=11");
    expect(calls[1]!.args).not.toContain("owner=owner");
    expect(calls[1]!.options.environment).toEqual({ GH_ENTERPRISE_TOKEN: fakeToken });
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(fakeToken);
    expect(process.env.GH_ENTERPRISE_TOKEN).toBe("");
  });

  it.each(["graphql-error", "rate-limited", "nonzero"])("keeps port credentials out of GraphQL %s diagnostics", async (mode) => {
    noEnterpriseEnvironment();
    const cause = Object.assign(new Error(`failure ${fakeToken}`), { code: 1, stdout: fakeToken, stderr: fakeToken });
    const body = mode === "nonzero" ? checks() : { ...checks(), errors: [{ type: mode === "rate-limited" ? "RATE_LIMITED" : "INTERNAL", message: fakeToken }] };
    const { client } = queue(credential(), response(body, {}, 200, cause));
    const error = await client.getPullRequestChecks({ ...repository, host: target.host }, 11).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(errorText(error)).not.toContain(fakeToken);
  });

  it.each(["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) ("respects an inherited %s without reading stored credentials", async (variable) => {
    noEnterpriseEnvironment();
    vi.stubEnv(variable, fakeToken);
    const { client, calls } = queue(response({ id: 42 }));
    await client.resolveRepository(target);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("api");
    expect(calls[0]!.options.environment).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(fakeToken);
  });

  it.each(["nonzero", "abort", "overflow", "throw", "malformed"]) ("sanitizes every credential capture failure %s", async (mode) => {
    noEnterpriseEnvironment();
    const cause = Object.assign(new Error(`stderr contains ${fakeToken}`), { code: mode === "overflow" ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : mode === "abort" ? "ABORT_ERR" : 1, stdout: fakeToken, stderr: fakeToken });
    const authentication = mode === "throw" ? cause : mode === "malformed" ? { stdout: `${fakeToken}\nsecond-line`, stderr: fakeToken, error: null } : credential(cause);
    const { client, calls } = queue(authentication);
    const error = await client.resolveRepository(target).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(errorText(error)).not.toContain(fakeToken);
    expect(errorText(error)).not.toContain("stdout");
    expect(errorText(error)).not.toContain("stderr");
    expect(calls).toHaveLength(1);
  });

  it.each(["nonzero", "throw", "malformed-http"]) ("sanitizes API process failures after a private credential bridge %s", async (mode) => {
    noEnterpriseEnvironment();
    const cause = Object.assign(new Error(`failure ${fakeToken}`), { code: 1, stdout: fakeToken, stderr: fakeToken });
    const result = mode === "throw" ? cause : mode === "malformed-http" ? { stdout: `HTTP/2.0 200 OK\n\n${fakeToken}`, stderr: fakeToken, error: null } : response({}, {}, 401, cause);
    const { client } = queue(credential(), result);
    const error = await client.resolveRepository(target).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(errorText(error)).not.toContain(fakeToken);
  });

  it("sanitizes API failure metadata when an enterprise token was already inherited", async () => {
    vi.stubEnv("GH_ENTERPRISE_TOKEN", fakeToken);
    const cause = Object.assign(new Error(`failure ${fakeToken}`), { code: 1, stdout: fakeToken, stderr: fakeToken });
    const { client } = queue(response({}, {}, 401, cause));
    const error = await client.resolveRepository(target).catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 401, cause: { code: 1 } });
    expect(errorText(error)).not.toContain(fakeToken);
  });

  it("retains HTML rate-limit headers without exposing private credential capture", async () => {
    noEnterpriseEnvironment();
    const cause = Object.assign(new Error(fakeToken), { code: 1, stdout: fakeToken, stderr: fakeToken });
    const { client, calls } = queue(credential(), rawResponse(`<html>${fakeToken}</html>`, { "Retry-After": "3600" }, 429, cause));
    const failure = await client.resolveRepository(target).catch((value: unknown) => value);
    expect(failure).toMatchObject({ status: 429, retryAt: 3_700_000, cause: { code: 1 } });
    expect(errorText(failure)).not.toContain(fakeToken);
    const skipped = await client.resolveRepository(target).catch((value: unknown) => value);
    expect(skipped).toMatchObject({ status: 429, retryAt: 3_700_000 });
    expect(errorText(skipped)).not.toContain(fakeToken);
    expect(calls).toHaveLength(2);
  });

  it("bridges a fake prepared credential through actual child processes without changing parent authentication", async () => {
    noEnterpriseEnvironment();
    const script = path.join(import.meta.dirname, "../../fixtures", "gh-api.mjs");
    const client = createGitHubClient({ execute: (_file, args, options) => executeCommand(process.execPath, [script, args[0] === "auth" ? "credential-success" : "credential-environment"], options) });
    expect(await client.resolveRepository(target)).toMatchObject({ githubId: "42", host: target.host });
    expect(process.env.GH_ENTERPRISE_TOKEN).toBe("");
  });

  it("persists only sanitized credential failure metadata", async () => {
    noEnterpriseEnvironment();
    const { store } = fixture();
    const { client } = queue(credential(), response({ id: 42 }), credential(Object.assign(new Error(fakeToken), { code: 1, stdout: fakeToken })));
    await expect(pollRepository(store, target, client, { now: () => 200_000 })).rejects.toThrow("authentication");
    const state = store.getRepository({ host: target.host, githubId: "42" });
    expect(state).toMatchObject({ startPrNumber: null, lastPollAt: null, lastPollError: expect.stringContaining("authentication") });
    expect(JSON.stringify(state)).not.toContain(fakeToken);
  });
});

describe("client rate-limit cooldown", () => {
  it("rechecks a host deadline after asynchronous credential preparation", async () => {
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "");
    vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "");
    const entered = Promise.withResolvers<void>();
    const heldAuthentication = Promise.withResolvers<CommandResult>();
    let authenticationCalls = 0;
    let apiCalls = 0;
    const credential: CommandResult = { stdout: "fake-shared-credential\n", stderr: "", error: null };
    const execute: CommandExecutor = async (_file, args) => {
      if (args[0] === "auth") {
        authenticationCalls++;
        if (authenticationCalls === 1) {
          entered.resolve();
          return heldAuthentication.promise;
        }
        return credential;
      }
      apiCalls++;
      return response({}, { "Retry-After": "3600" }, 429, exitError(1));
    };
    const client = createGitHubClient({ execute, now: () => 100_000 });
    const target = { ...configuration, host: "git.example:8443" };
    const pending = client.resolveRepository(target);
    await entered.promise;
    await expect(client.resolveRepository({ ...target, name: "second" })).rejects.toMatchObject({ status: 429, retryAt: 3_700_000 });
    heldAuthentication.resolve(credential);
    await expect(pending).rejects.toMatchObject({ status: 429, retryAt: 3_700_000 });
    expect(authenticationCalls).toBe(2);
    expect(apiCalls).toBe(1);
  });

  it("blocks every same-host API method until the latest deadline and allows other hosts immediately", async () => {
    let clock = 100_000;
    const queued = queue(response({}, { "Retry-After": "3600" }, 429, exitError(1)), response({ id: 43 }), response({ id: 42 }));
    const client = createGitHubClient({ execute: queued.execute, now: () => clock });
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status: 429, retryAt: 3_700_000 });
    await expect(client.resolveRepository({ ...configuration, name: "second" })).rejects.toMatchObject({ status: 429, retryAt: 3_700_000 });
    await expect(client.listOpenPullRequests(repository, 10)).rejects.toMatchObject({ retryAt: 3_700_000 });
    await expect(client.getPullRequest(repository, 11)).rejects.toMatchObject({ retryAt: 3_700_000 });
    await expect(client.getPullRequestChecks(repository, 11)).rejects.toMatchObject({ retryAt: 3_700_000 });
    await expect(client.listPullRequestNumbers(repository)).rejects.toMatchObject({ retryAt: 3_700_000 });
    expect(queued.calls).toHaveLength(1);
    expect(await client.resolveRepository({ ...configuration, host: "git.example" })).toMatchObject({ host: "git.example", githubId: "43" });
    clock = 3_699_999;
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ retryAt: 3_700_000 });
    expect(queued.calls).toHaveLength(2);
    clock = 3_700_000;
    expect(await client.resolveRepository(configuration)).toEqual(repository);
    expect(queued.calls).toHaveLength(3);
  });

  it("does not block later requests after an ordinary access-denied 403", async () => {
    const { client, calls } = queue(response({}, {}, 403, exitError(1)), response({ id: 42 }));
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status: 403, retryAt: null });
    expect(await client.resolveRepository(configuration)).toEqual(repository);
    expect(calls).toHaveLength(2);
  });

  it("returns a visible skipped same-host batch failure while another host succeeds", async () => {
    const { store } = fixture();
    const same = { ...configuration, name: "second", coordinate: "github.com/owner/second", path: path.resolve("second") };
    const other = { ...configuration, host: "git.example", coordinate: "git.example/owner/repo", path: path.resolve("other") };
    const { client, calls } = queue(response({ id: 42 }), response({}, { "Retry-After": "3600" }, 429, exitError(1)), response({ id: 43 }), response([]));
    const results = await pollRepositories(store, [configuration, same, other], client, { now: () => 100_000 });
    expect(results).toMatchObject([{ ok: false, error: { status: 429, retryAt: 3_700_000 } }, { ok: false, error: { status: 429, retryAt: 3_700_000 } }, { ok: true, repository: { host: "git.example", githubId: "43" } }]);
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.args.at(-1))).not.toContain("repos/owner/second");
  });
});

describe("RFC Link parameter parsing", () => {
  const target = link("all").split(";")[0]!;
  it.each([
    `${target}; rel = "next"`, `${target}; rel\t=\t"next"`, `${target}; rel=next`,
    `${target}; title="comma, semicolon; text"; rel = next`,
    String.raw`${target}; title="escaped \"quote\" and comma,semicolon;"; rel="next"`,
    String.raw`${target}; rel="nex\t"`, `${target}; rel="NEXT"`,
    `${target}; rel="https://example.test/relation;parameter next"`,
  ])("follows valid relation syntax %s", async (header) => {
    const { client, calls } = queue(response([{ number: 1 }], { Link: header }), response([{ number: 50 }]));
    expect(await client.listPullRequestNumbers(repository)).toEqual([1, 50]);
    expect(calls).toHaveLength(2);
  });

  it("uses only the first rel parameter as required by RFC 8288", async () => {
    const first = queue(response([{ number: 1 }], { Link: `${target}; rel="next"; rel="last"` }), response([{ number: 50 }]));
    expect(await first.client.listPullRequestNumbers(repository)).toEqual([1, 50]);
    expect(first.calls).toHaveLength(2);
    const last = queue(response([{ number: 1 }], { Link: `${target}; rel="last"; rel="next"` }));
    expect(await last.client.listPullRequestNumbers(repository)).toEqual([1]);
    expect(last.calls).toHaveLength(1);
  });

  it("preserves comma and semicolon inside quoted parameters when links are combined", async () => {
    const header = `<https://api.github.com/unused>; title="comma, semicolon;"; rel="previous", ${target}; title="second, title;"; rel = "next"`;
    const { client, calls } = queue(response([{ number: 1 }], { Link: header }), response([{ number: 50 }]));
    expect(await client.listPullRequestNumbers(repository)).toEqual([1, 50]);
    expect(calls).toHaveLength(2);
  });

  it.each([
    `${target}; rel="next`, `${target}; rel next`, `${target}; rel =`, `${target}; rel=`, `${target}; rel="next"junk`,
    `${target}; rel="next;last"`, `${target}; rel="next,last"`, `${target}; rel=""`, `${target}; rel`,
    `${target}; rel="next"; title="unterminated`, `${target}; rel="last"; title="unterminated`,
    `${target}; rel="next",`, `${target}; ="next"`,
  ])("rejects malformed parameters before initial cutoff can commit %s", async (header) => {
    const { store, poll } = fixture();
    const { client, calls } = queue(response({ id: 42 }), response([{ number: 1 }], { Link: header }));
    await expect(poll(client)).rejects.toThrow("Link header");
    expect(store.getRepository(repository)).toMatchObject({ startPrNumber: null, initializedAt: null, lastPollAt: null, lastPollError: expect.any(String) });
    expect(calls).toHaveLength(2);
  });
});

describe("HTTP errors with non-JSON bodies", () => {
  it.each([
    [429, "<html>Too many requests</html>", { "Content-Type": "text/html", "Retry-After": "3600" }, 3_700_000],
    [429, "", { "Retry-After": "3600" }, 3_700_000],
    [429, "", {}, 160_000],
    [403, "<html>Primary limit exceeded</html>", { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "900" }, 900_000],
    [403, "Please wait", { "Retry-After": new Date(500_000).toUTCString() }, 500_000],
  ])("preserves HTTP %s cooldowns across batches until their deadline regardless of body format", async (status, body, headers, retryAt) => {
    const { store } = fixture();
    const same = { ...configuration, name: "second", coordinate: "github.com/owner/second", path: path.resolve("second") };
    const other = { ...configuration, host: "git.example", coordinate: "git.example/owner/repo", path: path.resolve("other") };
    const cause = exitError(1);
    const queued = queue(response({ id: 42 }), rawResponse(body, headers, status, cause), response({ id: 43 }), response([]), response({ id: 42 }), response([]));
    let clock = 100_000;
    const client = createGitHubClient({ execute: queued.execute, now: () => clock });
    const results = await pollRepositories(store, [configuration, same, other], client, { now: () => clock });
    expect(results).toMatchObject([
      { ok: false, error: { status, retryAt, cause } },
      { ok: false, error: { status, retryAt } },
      { ok: true, repository: { host: "git.example", githubId: "43", startPrNumber: 0 } },
    ]);
    expect(queued.calls).toHaveLength(4);
    expect(queued.calls.map((call) => call.args.at(-1))).not.toContain("repos/owner/second");
    expect(store.getRepository(repository)).toMatchObject({ startPrNumber: null, lastPollAt: null, lastPollError: expect.stringContaining(`HTTP ${status}`) });
    expect(store.getRepository({ host: "git.example", githubId: "43" })?.lastPollAt).toBe(100_000);
    clock = retryAt - 1;
    await expect(pollRepository(store, configuration, client, { now: () => clock })).rejects.toMatchObject({ status, retryAt });
    expect(queued.calls).toHaveLength(4);
    clock = retryAt;
    expect(await pollRepository(store, configuration, client, { now: () => clock })).toMatchObject({ startPrNumber: 0, lastPollAt: retryAt, lastPollError: null });
    expect(queued.calls).toHaveLength(6);
  });

  it("preserves a non-rate-limit HTML 403 without creating a cooldown", async () => {
    const cause = exitError(1);
    const { client, calls } = queue(rawResponse("<html>Forbidden</html>", {}, 403, cause), response({ id: 42 }));
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status: 403, retryAt: null, cause });
    expect(await client.resolveRepository(configuration)).toEqual(repository);
    expect(calls).toHaveLength(2);
  });

  it.each(["<html>Unexpected success body</html>", "", "plain text"]) ("rejects a non-JSON HTTP 200 without committing observations %s", async (body) => {
    const { store, initialize, observe, poll } = fixture();
    initialize(); observe(11);
    const before = store.listPullRequests(repository);
    const { client } = queue(response({ id: 42 }), rawResponse(body));
    await expect(poll(client)).rejects.toMatchObject({ status: null, retryAt: null, cause: expect.any(SyntaxError) });
    expect(store.listPullRequests(repository)).toEqual(before);
    expect(store.getRepository(repository)).toMatchObject({ startPrNumber: 10, lastPollAt: 2, lastPollError: expect.stringContaining("Cannot parse GitHub response") });
  });

  it("recognizes actual native HTTP 429 HTML output before decoding its body", async () => {
    const script = path.join(import.meta.dirname, "../../fixtures", "gh-api.mjs");
    let calls = 0;
    const client = createGitHubClient({
      now: () => 100_000,
      execute: (_file, _args, options) => { calls++; return executeCommand(process.execPath, [script, "rate-limit-html"], options); },
    });
    await expect(client.resolveRepository(configuration)).rejects.toMatchObject({ status: 429, retryAt: 3_700_000, cause: { code: 1 } });
    await expect(client.getPullRequest(repository, 11)).rejects.toMatchObject({ status: 429, retryAt: 3_700_000 });
    expect(calls).toBe(1);
  });
});
