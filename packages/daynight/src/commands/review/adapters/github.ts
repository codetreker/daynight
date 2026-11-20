import { execFile } from "node:child_process";
import { remoteIdentity } from "../config.js";
import type { RepositoryConfiguration } from "../config.js";
import type { PullRequestObservation, PullRequestReviewSnapshot, RemoteReview, RemoteReviewThread, RepositoryIdentity } from "../model.js";
import { parsePullRequestReviewSnapshot, pullRequestReviewSnapshotQuery, reviewSnapshotCollection, type ReviewSnapshotPage } from "./github-review-state.js";
import { parseGitHubJson, repositoryId } from "./github-id.js";

export type CommandOptions = {
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
  environment?: Record<string, string | undefined>;
};
export type CommandResult = { stdout: string; stderr: string; error: Error | null };
export type CommandExecutor = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;
export type GitHubRepository = RepositoryIdentity & { owner: string; name: string };
export type PullRequestChecks = { headSha: string; baseRef: string; ready: boolean };
export type GitHubClient = {
  resolveRepository: (configuration: RepositoryConfiguration, signal?: AbortSignal) => Promise<GitHubRepository>;
  resolveRepositoryById: (identity: RepositoryIdentity, signal?: AbortSignal) => Promise<GitHubRepository>;
  listPullRequestNumbers: (repository: GitHubRepository, signal?: AbortSignal) => Promise<number[]>;
  listOpenPullRequests: (repository: GitHubRepository, cutoff: number, signal?: AbortSignal) => Promise<PullRequestObservation[]>;
  getPullRequest: (repository: GitHubRepository, number: number, signal?: AbortSignal) => Promise<PullRequestObservation>;
  getPullRequestChecks: (repository: GitHubRepository, number: number, signal?: AbortSignal) => Promise<PullRequestChecks>;
  getPullRequestReviewSnapshot: (repository: GitHubRepository, number: number, signal?: AbortSignal) => Promise<PullRequestReviewSnapshot>;
};

export class GitHubApiError extends Error {
  readonly status: number | null;
  readonly retryAt: number | null;

  constructor(message: string, options: { status?: number; retryAt?: number | null; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "GitHubApiError";
    this.status = options.status === undefined ? null : options.status;
    this.retryAt = options.retryAt === undefined ? null : options.retryAt;
  }
}

export const executeCommand: CommandExecutor = (file, args, options) => new Promise((resolve) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_FORCE_TTY: "", NO_COLOR: "1", PAGER: "cat", GH_PAGER: "cat", ...options.environment };
  delete env.GH_DEBUG;
  execFile(file, [...args], {
    encoding: "utf8", windowsHide: true, timeout: options.timeoutMs, maxBuffer: options.maxBufferBytes,
    env, ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
});

type HttpFrame = { status: number; headers: Map<string, string[]>; body: string };
type HttpResponse = Omit<HttpFrame, "body"> & { body: unknown; bodyBytes: number };
const object = (value: unknown, subject: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${subject} must be an object.`);
  return value as Record<string, unknown>;
};
const positiveInteger = (value: unknown, subject: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${subject} must be a positive safe integer.`);
  return value;
};
const text = (value: unknown, subject: string): string => {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/.test(value)) throw new Error(`${subject} must be nonempty text without control characters.`);
  return value;
};
const pullRequestNumber = (value: unknown): number => positiveInteger(object(value, "PR").number, "PR number");
const observation = (value: unknown): PullRequestObservation => {
  const data = object(value, "PR");
  const number = pullRequestNumber(data);
  if (data.state !== "open" && data.state !== "closed") throw new Error(`PR ${number} has an invalid state.`);
  if (typeof data.draft !== "boolean") throw new Error(`PR ${number} has an invalid Draft flag.`);
  if (data.merged_at !== null && (typeof data.merged_at !== "string" || !Number.isFinite(Date.parse(data.merged_at)))) throw new Error(`PR ${number} has an invalid merge time.`);
  if (data.merged !== undefined && typeof data.merged !== "boolean") throw new Error(`PR ${number} has an invalid merged flag.`);
  const merged = data.merged_at !== null || data.merged === true;
  if (merged && data.state !== "closed") throw new Error(`PR ${number} is merged but not closed.`);
  if (data.merged === false && data.merged_at !== null) throw new Error(`PR ${number} has inconsistent merge fields.`);
  const head = object(data.head, `PR ${number} head`);
  const base = object(data.base, `PR ${number} base`);
  return {
    number, state: merged ? "merged" : data.state, draft: data.draft,
    headSha: text(head.sha, `PR ${number} head SHA`), baseRef: text(base.ref, `PR ${number} base branch`),
    baseSha: text(base.sha, `PR ${number} base SHA`),
  };
};

const pullRequestChecksQuery = `query PullRequestChecks($owner: String!, $name: String!, $number: Int!, $headCursor: String, $mergeCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft headRefOid baseRefName
      commits(last: 1) { nodes { commit {
        oid statusCheckRollup { state }
        checkSuites(first: 100, after: $headCursor) { ...SuitePage }
      } } }
      potentialMergeCommit {
        oid statusCheckRollup { state }
        checkSuites(first: 100, after: $mergeCursor) { ...SuitePage }
      }
    }
  }
}
fragment SuitePage on CheckSuiteConnection {
  totalCount
  nodes {
    id status conclusion
    workflowRun { event runNumber runAttempt workflow { id } }
  }
  pageInfo { hasNextPage endCursor }
}`;
type ChecksQuery = { owner: string; name: string; number: number; headCursor: string | null; mergeCursor: string | null };
type GraphQLQuery = { document: string; variables: Record<string, string | number | null> };
type CheckSuite = { id: string; ready: boolean; workflow: { key: string; runNumber: number; runAttempt: number } | null };
type SuitePage = { totalCount: number; suites: CheckSuite[]; cursor: string | null };
type ChecksSnapshot = PullRequestChecks & { mergeSha: string | null; headSuites: SuitePage; mergeSuites: SuitePage | null };
const suitePage = (value: unknown, subject: string): SuitePage => {
  const connection = object(value, `${subject} check suites`);
  const totalCount = connection.totalCount;
  if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0) throw new Error(`${subject} has an invalid check-suite count.`);
  if (!Array.isArray(connection.nodes) || connection.nodes.length > 100) throw new Error(`${subject} has an invalid check-suite page.`);
  const suites = connection.nodes.map((value: unknown): CheckSuite => {
    const suite = object(value, `${subject} check suite`);
    if (typeof suite.status !== "string" || !["REQUESTED", "QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "PENDING"].includes(suite.status)) throw new Error(`${subject} has an invalid check-suite status.`);
    if (suite.conclusion !== null && (typeof suite.conclusion !== "string" || !["ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "FAILURE", "SUCCESS", "NEUTRAL", "SKIPPED", "STARTUP_FAILURE", "STALE"].includes(suite.conclusion))) throw new Error(`${subject} has an invalid check-suite conclusion.`);
    let workflow: CheckSuite["workflow"] = null;
    if (suite.workflowRun !== null) {
      const run = object(suite.workflowRun, `${subject} workflow run`);
      workflow = {
        key: JSON.stringify([text(object(run.workflow, `${subject} workflow`).id, `${subject} workflow ID`), text(run.event, `${subject} workflow event`)]),
        runNumber: positiveInteger(run.runNumber, `${subject} workflow run number`),
        runAttempt: positiveInteger(run.runAttempt, `${subject} workflow run attempt`),
      };
    }
    return { id: text(suite.id, `${subject} check-suite ID`), ready: suite.status === "COMPLETED" && typeof suite.conclusion === "string" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(suite.conclusion), workflow };
  });
  const info = object(connection.pageInfo, `${subject} check-suite page info`);
  if (typeof info.hasNextPage !== "boolean" || (info.endCursor !== null && typeof info.endCursor !== "string")) throw new Error(`${subject} has invalid check-suite pagination.`);
  const cursor = info.endCursor === null ? null : text(info.endCursor, `${subject} check-suite cursor`);
  if (info.hasNextPage && (cursor === null || suites.length === 0)) throw new Error(`${subject} has an incomplete check-suite page.`);
  return { totalCount, suites, cursor: info.hasNextPage ? cursor : null };
};
const suiteCollection = (subject: string) => {
  let ready = true;
  let expectedCount: number | null = null;
  let complete = false;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  const collected = new Set<string>();
  const workflows = new Map<string, { runNumber: number; runAttempt: number; ready: boolean }>();
  return {
    observe: (page: SuitePage): void => {
      if (expectedCount === null) expectedCount = page.totalCount;
      else if (page.totalCount !== expectedCount) throw new Error(`${subject} check-suite count changed during pagination.`);
      for (const suite of page.suites) {
        if (complete && !collected.has(suite.id)) throw new Error(`${subject} check-suite membership changed after collection.`);
        // Without a workflow identity, no later suite can prove this one was superseded.
        if (suite.workflow === null) { ready &&= suite.ready; continue; }
        const { key, runNumber, runAttempt } = suite.workflow;
        const previous = workflows.get(key);
        // New runs increment runNumber; reruns increment runAttempt while retaining runNumber.
        // https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context
        if (previous === undefined || runNumber > previous.runNumber || (runNumber === previous.runNumber && runAttempt > previous.runAttempt)) {
          workflows.set(key, { runNumber, runAttempt, ready: suite.ready });
        } else if (runNumber === previous.runNumber && runAttempt === previous.runAttempt) {
          previous.ready &&= suite.ready;
        }
      }
      if (complete) return;
      for (const suite of page.suites) {
        if (collected.has(suite.id)) throw new Error(`${subject} repeated a check-suite ID during pagination.`);
        collected.add(suite.id);
      }
      if (collected.size > expectedCount) throw new Error(`${subject} returned more check suites than its count.`);
      if (page.cursor === null) {
        if (collected.size !== expectedCount) throw new Error(`${subject} returned an incomplete check-suite collection.`);
        complete = true;
      } else {
        if (collected.size === expectedCount) throw new Error(`${subject} has a check-suite cursor after its complete collection.`);
        if (cursors.has(page.cursor)) throw new Error(`${subject} repeated a check-suite cursor.`);
        cursors.add(page.cursor);
        cursor = page.cursor;
      }
    },
    complete: (): boolean => complete,
    cursor: (): string | null => cursor,
    ready: (): boolean => ready && [...workflows.values()].every((run) => run.ready),
  };
};
const checksReady = (value: unknown, subject: string): boolean => {
  if (value === null) return true;
  const rollup = object(value, `${subject} status-check rollup`);
  if (typeof rollup.state !== "string" || !["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"].includes(rollup.state)) throw new Error(`${subject} has an invalid status-check state.`);
  return rollup.state === "SUCCESS";
};
const pullRequestChecks = (value: unknown): ChecksSnapshot => {
  const data = object(object(value, "GraphQL response").data, "GraphQL data");
  const repository = object(data.repository, "GitHub repository");
  const pullRequest = object(repository.pullRequest, "PR");
  if (pullRequest.state !== "OPEN" && pullRequest.state !== "CLOSED" && pullRequest.state !== "MERGED") throw new Error("PR has an invalid state.");
  if (typeof pullRequest.isDraft !== "boolean") throw new Error("PR has an invalid Draft flag.");
  const headSha = text(pullRequest.headRefOid, "PR head SHA");
  const baseRef = text(pullRequest.baseRefName, "PR base branch");
  const commits = object(pullRequest.commits, "PR commits");
  if (!Array.isArray(commits.nodes) || commits.nodes.length !== 1) throw new Error("PR must have exactly one latest commit.");
  const head = object(object(commits.nodes[0], "PR latest commit node").commit, "PR latest commit");
  if (text(head.oid, "PR latest commit SHA") !== headSha) throw new Error("PR latest commit does not match its head SHA.");
  const headReady = checksReady(head.statusCheckRollup, "PR head");
  let mergeReady = true;
  let mergeSha: string | null = null;
  let mergeSuites: SuitePage | null = null;
  if (pullRequest.potentialMergeCommit !== null) {
    const merge = object(pullRequest.potentialMergeCommit, "PR potential merge commit");
    mergeSha = text(merge.oid, "PR potential merge commit SHA");
    mergeReady = checksReady(merge.statusCheckRollup, "PR potential merge commit");
    mergeSuites = suitePage(merge.checkSuites, "PR potential merge commit");
  }
  return { headSha, baseRef, mergeSha, headSuites: suitePage(head.checkSuites, "PR head"), mergeSuites,
    ready: pullRequest.state === "OPEN" && !pullRequest.isDraft && headReady && mergeReady };
};

const parseHttpFrame = (stdout: string): HttpFrame => {
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (separator === null) throw new Error("GitHub CLI output has no complete HTTP header block.");
  const lines = stdout.slice(0, separator.index).split(/\r?\n/);
  const statusLine = /^HTTP\/\d(?:\.\d)? ([1-5]\d\d)(?: [^\r\n]*)?$/.exec(lines.shift()!);
  if (statusLine === null) throw new Error("GitHub CLI output has an invalid HTTP status line.");
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~\da-z-]+):[ \t]*(.*)$/i.exec(line);
    if (match === null) throw new Error("GitHub CLI output has an invalid HTTP header.");
    const key = match[1]!.toLowerCase();
    const values = headers.get(key);
    if (values === undefined) headers.set(key, [match[2]!]); else values.push(match[2]!);
  }
  return { status: Number(statusLine[1]), headers, body: stdout.slice(separator.index + separator[0].length) };
};
const apiBase = (host: string): URL => {
  const origin = new URL(`https://${host}`);
  if (origin.host === "github.com") return new URL("https://api.github.com/");
  if (origin.host.endsWith(".ghe.com")) return new URL(`https://api.${origin.host}/`);
  return new URL(`https://${origin.host}/api/v3/`);
};
const graphQLApi = (host: string): URL => {
  const rest = apiBase(host);
  return new URL(rest.pathname === "/" ? "graphql" : "/api/graphql", rest);
};
const secondaryRateLimit = (body: string): boolean => {
  let data: unknown;
  try { data = JSON.parse(body) as unknown; } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return typeof data === "object" && data !== null && !Array.isArray(data) &&
    "message" in data && typeof data.message === "string" && /rate limit|abuse detection/i.test(data.message);
};
const rateLimitRetryAt = (response: HttpFrame, now: number, graphQLRateLimited = false): number | null => {
  if (response.status !== 403 && response.status !== 429 && !graphQLRateLimited) return null;
  const retryAfter = response.headers.get("retry-after") ?? [];
  const remaining = response.headers.get("x-ratelimit-remaining") ?? [];
  const limited = graphQLRateLimited || response.status === 429 || remaining.includes("0") || retryAfter.length !== 0 || secondaryRateLimit(response.body);
  if (!limited) return null;
  const deadlines = [now + 60_000];
  for (const value of retryAfter) {
    const deadline = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
    if (!Number.isSafeInteger(deadline)) throw new Error("GitHub returned an invalid Retry-After deadline.");
    deadlines.push(deadline);
  }
  if (remaining.includes("0") || graphQLRateLimited) {
    for (const value of response.headers.get("x-ratelimit-reset") ?? []) {
      const deadline = /^\d+$/.test(value) ? Number(value) * 1000 : NaN;
      if (!Number.isSafeInteger(deadline)) throw new Error("GitHub returned an invalid rate-limit reset deadline.");
      deadlines.push(deadline);
    }
  }
  return Math.max(...deadlines);
};
type PaginationLink = { target: string; relations: string[] };
const parseLinks = (header: string): PaginationLink[] => {
  const links: PaginationLink[] = [];
  let position = 0;
  const invalid = (): never => { throw new Error("GitHub returned an invalid pagination Link header."); };
  const whitespace = (): void => { while (header[position] === " " || header[position] === "\t") position++; };
  const token = (): string => {
    const start = position;
    while (position < header.length && /[!#$%&'*+.^_`|~\da-z-]/i.test(header[position]!)) position++;
    if (position === start) invalid();
    return header.slice(start, position);
  };
  const value = (): string => {
    if (header[position] !== '"') return token();
    position++;
    let result = "";
    while (position < header.length) {
      let character = header[position++]!;
      if (character === '"') return result;
      if (character === "\\") {
        if (position === header.length) invalid();
        character = header[position++]!;
      }
      const code = character.charCodeAt(0);
      if ((code < 32 && code !== 9) || code === 127) invalid();
      result += character;
    }
    return invalid();
  };
  whitespace();
  while (position < header.length) {
    if (header[position++] !== "<") invalid();
    const start = position;
    while (position < header.length && header[position] !== ">") {
      if (/[\x00-\x20\x7f<]/.test(header[position]!)) invalid();
      position++;
    }
    if (position === header.length) invalid();
    const target = header.slice(start, position++);
    let relations: string[] = [];
    let hasRelation = false;
    whitespace();
    while (position < header.length && header[position] !== ",") {
      if (header[position++] !== ";") invalid();
      whitespace();
      const name = token().toLowerCase();
      whitespace();
      let parameter: string | null = null;
      if (header[position] === "=") {
        position++;
        whitespace();
        parameter = value();
        whitespace();
      }
      // Later rel parameters are ignored: https://www.rfc-editor.org/rfc/rfc8288.html#section-3.3
      if (name === "rel" && !hasRelation) {
        if (parameter === null || parameter === "" || parameter.trim() !== parameter) invalid();
        hasRelation = true;
        relations = parameter!.split(/ +/);
        for (const relation of relations) {
          if (/^[a-z][a-z\d.-]*$/i.test(relation)) continue;
          try { new URL(relation); } catch { invalid(); }
        }
      }
    }
    links.push({ target, relations });
    if (position === header.length) break;
    position++;
    whitespace();
    if (position === header.length) invalid();
  }
  if (links.length === 0) invalid();
  return links;
};
const nextPage = (response: HttpResponse, current: URL, repository: GitHubRepository, scan: URL): URL | null => {
  let next: URL | null = null;
  for (const header of response.headers.get("link") ?? []) {
    for (const entry of parseLinks(header)) {
      if (!entry.relations.some((relation) => relation.toLowerCase() === "next")) continue;
      if (next !== null) throw new Error("GitHub returned more than one next page.");
      const url = new URL(entry.target);
      const base = apiBase(repository.host);
      const prefix = base.pathname;
      const allowed = [`${prefix}repos/${repository.owner}/${repository.name}/pulls`, `${prefix}repositories/${repository.githubId}/pulls`];
      if (url.protocol !== "https:" || url.origin !== base.origin || url.username !== "" || url.password !== "" || url.hash !== "" || !allowed.includes(url.pathname)) {
        throw new Error("GitHub pagination points outside the expected repository API.");
      }
      const keys = new Set([...scan.searchParams.keys(), ...url.searchParams.keys()]);
      for (const key of keys) {
        const values = url.searchParams.getAll(key);
        if (key !== "page" && (values.length !== 1 || values[0] !== scan.searchParams.get(key))) throw new Error("GitHub pagination changed scan parameters.");
      }
      const pages = url.searchParams.getAll("page");
      if (pages.length !== 1 || !/^[1-9]\d*$/.test(pages[0]!) || !Number.isSafeInteger(Number(pages[0])) || Number(pages[0]) <= Number(current.searchParams.get("page"))) {
        throw new Error("GitHub pagination did not advance to a later page.");
      }
      next = url;
    }
  }
  return next;
};
// Credential command errors may contain captured output, so only process metadata is retained.
export const sanitizedProcessError = (error: unknown): Error => {
  const sanitized = new Error("GitHub CLI did not complete successfully.");
  if (typeof error === "object" && error !== null) {
    const failure = error as Record<string, unknown>;
    if (typeof failure.code === "number" || (typeof failure.code === "string" && /^[A-Z][A-Z\d_]*$/.test(failure.code))) Object.assign(sanitized, { code: failure.code });
    if (typeof failure.killed === "boolean") Object.assign(sanitized, { killed: failure.killed });
    if (failure.signal === null || (typeof failure.signal === "string" && /^SIG[A-Z\d]+$/.test(failure.signal))) Object.assign(sanitized, { signal: failure.signal });
  }
  return sanitized;
};

export type GitHubAuthentication = {
  hostname: string;
  environment: Record<string, string | undefined> | undefined;
  sensitive: boolean;
};

export const prepareGitHubAuthentication = async (
  host: string,
  execute: CommandExecutor,
  options: Pick<CommandOptions, "timeoutMs" | "maxBufferBytes" | "signal">,
): Promise<GitHubAuthentication> => {
  const origin = new URL(`https://${host}`);
  const sensitive = origin.port !== "";
  let environment: Record<string, string | undefined> | undefined;
  if (sensitive && !process.env.GH_ENTERPRISE_TOKEN && !process.env.GITHUB_ENTERPRISE_TOKEN) {
    let authentication: CommandResult;
    try {
      authentication = await execute("gh", ["auth", "token", "--hostname", origin.hostname], options);
    } catch (cause) {
      throw new GitHubApiError(`Cannot obtain prepared GitHub authentication for ${origin.hostname}.`, { cause: sanitizedProcessError(cause) });
    }
    const token = authentication.stdout.trim();
    if (authentication.error !== null || options.signal?.aborted || !/^[^\s\0]+$/.test(token)) {
      throw new GitHubApiError(`Cannot obtain prepared GitHub authentication for ${origin.hostname}.`, { cause: sanitizedProcessError(authentication.error) });
    }
    environment = { GH_ENTERPRISE_TOKEN: token };
  }
  return { hostname: origin.hostname, environment, sensitive };
};

export const createGitHubClient = (options: {
  execute?: CommandExecutor;
  now?: () => number;
  timeoutMs?: number;
  maxBufferBytes?: number;
} = {}): GitHubClient => {
  const execute = options.execute === undefined ? executeCommand : options.execute;
  const now = options.now === undefined ? Date.now : options.now;
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  const maxBufferBytes = options.maxBufferBytes === undefined ? 16 * 1024 * 1024 : options.maxBufferBytes;
  positiveInteger(timeoutMs, "GitHub request timeout");
  positiveInteger(maxBufferBytes, "GitHub response size limit");
  if (timeoutMs > 2_147_483_647) throw new Error("GitHub request timeout exceeds the supported timer limit.");
  const cooldowns = new Map<string, { error: GitHubApiError; status: number; retryAt: number }>();
  const requireAvailableHost = (host: string, origin: string): void => {
    const cooldown = cooldowns.get(origin);
    if (cooldown !== undefined) {
      if (now() < cooldown.retryAt) {
        throw new GitHubApiError(`GitHub API requests for ${host} are paused until ${cooldown.retryAt}.`, {
          status: cooldown.status, retryAt: cooldown.retryAt, cause: cooldown.error,
        });
      }
      cooldowns.delete(origin);
    }
  };
  const request = async (host: string, endpoint: string, signal?: AbortSignal, query?: GraphQLQuery): Promise<HttpResponse> => {
    const base = apiBase(host);
    requireAvailableHost(host, base.origin);
    const origin = new URL(`https://${host}`);
    const ported = origin.port !== "";
    let target = endpoint;
    if (ported) {
      const url = query === undefined ? new URL(endpoint, base) : graphQLApi(host);
      if (url.origin !== base.origin || url.username !== "" || url.password !== "" || url.hash !== "" || (query === undefined && !url.pathname.startsWith(base.pathname))) {
        throw new GitHubApiError(`Cannot construct a GitHub API URL for ${host}.`);
      }
      target = url.href;
    }
    const authentication = await prepareGitHubAuthentication(host, execute,
      { timeoutMs, maxBufferBytes, ...(signal === undefined ? {} : { signal }) });
    requireAvailableHost(host, base.origin);
    let result: CommandResult;
    try {
      // gh only groups flat variables for the literal "graphql" endpoint, not absolute URLs.
      // https://github.com/cli/cli/blob/fa92838bef95fe4a29c1587693885d5e9bdb6cf1/pkg/cmd/api/http.go#L16-L55
      const variable = (name: string): string => ported ? `variables[${name}]` : name;
      const fields = query === undefined ? [] : ["--raw-field", `query=${query.document}`,
        ...Object.entries(query.variables).flatMap(([key, value]) => [typeof value === "string" ? "--raw-field" : "--field", `${variable(key)}=${value === null ? "null" : value}`])];
      result = await execute("gh", ["api", "--include", "--method", query === undefined ? "GET" : "POST", "--hostname", ported ? origin.hostname : host,
        "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28", ...fields, target],
      { timeoutMs, maxBufferBytes, ...(signal === undefined ? {} : { signal }), ...(authentication.environment === undefined ? {} : { environment: authentication.environment }) });
    } catch (cause) {
      throw new GitHubApiError(`GitHub request failed for ${host}/${endpoint}.`, { cause: ported ? sanitizedProcessError(cause) : cause });
    }
    const failure = result.error;
    const publicFailure = !ported || failure === null ? failure : sanitizedProcessError(failure);
    if (signal?.aborted || (failure !== null && (!("code" in failure) || typeof failure.code !== "number" || ("killed" in failure && failure.killed === true) || ("signal" in failure && failure.signal !== null && failure.signal !== undefined)))) {
      throw new GitHubApiError(`GitHub request did not produce complete output for ${host}/${endpoint}.`, {
        cause: failure === null ? (ported ? sanitizedProcessError(signal?.reason) : signal?.reason) : publicFailure,
      });
    }
    let response: HttpFrame;
    try { response = parseHttpFrame(result.stdout); } catch (cause) {
      const publicCause = ported ? sanitizedProcessError(cause) : cause;
      throw new GitHubApiError(`Cannot parse GitHub response for ${host}/${endpoint}.`, {
        cause: publicFailure === null ? publicCause : new AggregateError([publicFailure, publicCause], "GitHub CLI failed and its response was invalid."),
      });
    }
    // A 429 may carry HTML: https://www.rfc-editor.org/rfc/rfc6585.html#section-4
    if (response.status < 200 || response.status >= 300) {
      let retryAt: number | null;
      try { retryAt = rateLimitRetryAt(response, now()); } catch (cause) {
        throw new GitHubApiError(`GitHub HTTP ${response.status} returned invalid retry metadata for ${host}/${endpoint}.`, {
          status: response.status, cause: publicFailure === null ? cause : new AggregateError([publicFailure, cause]),
        });
      }
      const error = new GitHubApiError(`GitHub HTTP ${response.status} for ${host}/${endpoint}.`, {
        status: response.status, retryAt, ...(publicFailure === null ? {} : { cause: publicFailure }),
      });
      if (retryAt !== null) cooldowns.set(base.origin, { error, status: response.status, retryAt });
      throw error;
    }
    if (publicFailure !== null && query === undefined) throw new GitHubApiError(`GitHub CLI exited unsuccessfully after HTTP ${response.status} for ${host}/${endpoint}.`, { cause: publicFailure });
    let body: unknown;
    try { body = parseGitHubJson(response.body); } catch (cause) {
      throw new GitHubApiError(`Cannot parse GitHub response for ${host}/${endpoint}.`, { cause: ported ? sanitizedProcessError(cause) : cause });
    }
    if (query !== undefined) {
      const errors = object(body, "GraphQL response").errors;
      if (errors !== undefined) {
        if (!Array.isArray(errors)) throw new GitHubApiError(`GitHub GraphQL returned invalid errors for ${host}/${endpoint}.`);
        if (errors.length !== 0) {
          const limited = errors.some((error: unknown) => object(error, "GraphQL error").type === "RATE_LIMITED");
          let retryAt: number | null;
          try { retryAt = rateLimitRetryAt(response, now(), limited); } catch (cause) {
            throw new GitHubApiError(`GitHub GraphQL returned invalid retry metadata for ${host}/${endpoint}.`, {
              status: response.status, cause: publicFailure === null ? cause : new AggregateError([publicFailure, cause]),
            });
          }
          const error = new GitHubApiError(`GitHub GraphQL returned errors for ${host}/${endpoint}.`, {
            status: response.status, retryAt, ...(publicFailure === null ? {} : { cause: publicFailure }),
          });
          if (retryAt !== null) cooldowns.set(base.origin, { error, status: response.status, retryAt });
          throw error;
        }
      }
    }
    if (publicFailure !== null) throw new GitHubApiError(`GitHub CLI exited unsuccessfully after HTTP ${response.status} for ${host}/${endpoint}.`, { cause: publicFailure });
    return { ...response, body, bodyBytes: Buffer.byteLength(response.body, "utf8") };
  };
  const scan = async <T>(repository: GitHubRepository, state: "all" | "open", project: (item: unknown) => T, signal?: AbortSignal): Promise<T[]> => {
    const base = apiBase(repository.host);
    const first = new URL(`repos/${repository.owner}/${repository.name}/pulls`, base);
    first.search = new URLSearchParams({ state, sort: "created", direction: "asc", per_page: "100", page: "1" }).toString();
    let page: URL | null = first;
    const visited = new Set<string>();
    const results = new Map<number, T>();
    while (page !== null) {
      if (visited.has(page.href)) throw new Error("GitHub pagination repeated a page.");
      visited.add(page.href);
      const response = await request(repository.host, page.pathname.slice(base.pathname.length) + page.search, signal);
      if (!Array.isArray(response.body)) throw new Error("GitHub PR list must be an array.");
      for (const item of response.body) results.set(pullRequestNumber(item), project(item));
      page = nextPage(response, page, repository, first);
    }
    return [...results.values()];
  };
  return {
    resolveRepository: async (configuration, signal) => {
      const response = await request(configuration.host, `repos/${configuration.owner}/${configuration.name}`, signal);
      const data = object(response.body, "GitHub repository");
      return { host: configuration.host, githubId: repositoryId(data.id, "GitHub repository ID"), owner: configuration.owner, name: configuration.name };
    },
    resolveRepositoryById: async (identity, signal) => {
      if (!/^[1-9]\d*$/.test(identity.githubId)) throw new Error("GitHub repository ID must be a positive decimal integer.");
      const response = await request(identity.host, `repositories/${identity.githubId}`, signal);
      const data = object(response.body, "GitHub repository");
      if (repositoryId(data.id, "GitHub repository ID") !== identity.githubId) throw new Error("GitHub returned a different repository than requested.");
      const name = text(data.full_name, "GitHub repository full name");
      const coordinate = remoteIdentity(`https://${identity.host}/${name}.git`, "GitHub repository full name");
      if (coordinate.host !== identity.host) throw new Error("GitHub returned a repository on a different host.");
      return { host: identity.host, githubId: identity.githubId, owner: coordinate.owner, name: coordinate.name };
    },
    listPullRequestNumbers: (repository, signal) => scan(repository, "all", pullRequestNumber, signal),
    listOpenPullRequests: async (repository, cutoff, signal) => {
      const results = (await scan(repository, "open", (item) => item, signal)).filter((item) => pullRequestNumber(item) > cutoff).map(observation);
      if (results.some((item) => item.state !== "open")) throw new Error("GitHub open PR list contains a closed PR.");
      return results;
    },
    getPullRequest: async (repository, number, signal) => {
      positiveInteger(number, "PR number");
      const response = await request(repository.host, `repos/${repository.owner}/${repository.name}/pulls/${number}`, signal);
      const base = object(object(response.body, "PR").base, "PR base");
      if (repositoryId(object(base.repo, "PR base repository").id, "PR base repository ID") !== repository.githubId) throw new Error("GitHub returned a PR from a different repository.");
      const result = observation(response.body);
      if (result.number !== number) throw new Error("GitHub returned a different PR than requested.");
      return result;
    },
    getPullRequestChecks: async (repository, number, signal) => {
      positiveInteger(number, "PR number");
      const query: ChecksQuery = { owner: repository.owner, name: repository.name, number, headCursor: null, mergeCursor: null };
      const head = suiteCollection("PR HEAD");
      const merge = suiteCollection("PR merge commit");
      let first: ChecksSnapshot | null = null;
      let ready = true;
      do {
        const response = await request(repository.host, "graphql", signal, { document: pullRequestChecksQuery, variables: query });
        const snapshot = pullRequestChecks(response.body);
        if (first === null) first = snapshot;
        else if (snapshot.headSha !== first.headSha || snapshot.baseRef !== first.baseRef || snapshot.mergeSha !== first.mergeSha) throw new Error("PR CI target changed during check-suite pagination.");
        ready &&= snapshot.ready;
        head.observe(snapshot.headSuites);
        if (snapshot.mergeSuites !== null) merge.observe(snapshot.mergeSuites);
        query.headCursor = head.cursor();
        query.mergeCursor = merge.cursor();
      } while (!head.complete() || (first.mergeSha !== null && !merge.complete()));
      return { headSha: first.headSha, baseRef: first.baseRef, ready: ready && head.ready() && merge.ready() };
    },
    getPullRequestReviewSnapshot: async (repository, number, signal) => {
      positiveInteger(number, "PR number");
      const variables = { owner: repository.owner, name: repository.name, number, reviewCursor: null as string | null, threadCursor: null as string | null };
      const reviews = reviewSnapshotCollection<RemoteReview>("PR reviews");
      const threads = reviewSnapshotCollection<RemoteReviewThread>("PR review threads");
      let first: ReviewSnapshotPage | null = null;
      let pages = 0;
      let bytes = 0;
      do {
        if (++pages > 1_000) throw new Error("PR review snapshot exceeded its pagination limit.");
        const response = await request(repository.host, "graphql", signal, { document: pullRequestReviewSnapshotQuery, variables });
        bytes += response.bodyBytes;
        if (bytes > maxBufferBytes) throw new Error("PR review snapshot exceeded its response size limit.");
        const snapshot = parsePullRequestReviewSnapshot(response.body, repository.githubId, number);
        if (first === null) first = snapshot;
        else if (snapshot.state !== first.state || snapshot.draft !== first.draft || snapshot.headSha !== first.headSha || snapshot.baseRef !== first.baseRef || snapshot.viewerId !== first.viewerId) throw new Error("PR review target or viewer changed during pagination.");
        reviews.observe(snapshot.reviews);
        threads.observe(snapshot.threads);
        variables.reviewCursor = reviews.cursor();
        variables.threadCursor = threads.cursor();
      } while (!reviews.complete() || !threads.complete());
      return { state: first.state, draft: first.draft, headSha: first.headSha, baseRef: first.baseRef, viewerId: first.viewerId, reviews: reviews.nodes(), threads: threads.nodes() };
    },
  };
};
