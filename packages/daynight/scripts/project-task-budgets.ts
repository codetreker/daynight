import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { performance } from "node:perf_hooks";
import type { InstalledCliReceipt } from "../test/fixtures/installed-cli.js";
import type { DeadlineLimits } from "../test/fixtures/installed-operation-limits.js";

const mib = 1_048_576;
const responseLimit = 128 * mib;
const totalLimit = 256 * mib;
const requestMs = 30_000;
const totalMs = 300_000;
const deadlineLimits: DeadlineLimits = { totalMs: 3_000, requestMs: 1_000 };
const outputLimit = 64 * 1024;
const filler = Buffer.alloc(64 * 1024, " ");

export type BudgetProbeReceipt = {
  name: string;
  passed: boolean;
  elapsedMs: number;
  deadlines: DeadlineLimits & { mocked: boolean };
  requests: number;
  bearerRequests: number;
  credentialSource: "normal-uniauth-session-pat";
  authenticationScope: "bearer-transport-only";
  completedPages: number;
  uniqueCursors: number;
  responseBodyBytes: number[];
  generatedDecodedBytes: number;
  compressedBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBytes: number;
  stdout: string;
  stderr: string;
  childReaped: boolean;
  socketsClosed: boolean;
  serverClosed: boolean;
  fixtureRemoved: boolean;
  failures: string[];
};

export const describeAcceptanceError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error).slice(0, 16_384);
  return [error.message,
    ...(error instanceof AggregateError ? error.errors.map(describeAcceptanceError) : []),
    ...(error.cause === undefined ? [] : [`Caused by: ${describeAcceptanceError(error.cause)}`]),
  ].join("\n").slice(0, 16_384);
};

const requireCondition = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
const project = (index: number) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Budget project ${index}`,
  repoUrl: `https://git.example/budget/repo-${index}.git`,
  settings: { version: 1, executionWarningMinutes: 60 },
  ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1 },
  createdAt: new Date(Date.UTC(2026, 9, 20) + index).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 20) + index).toISOString(),
});

export const createBudgetProjectPage = (index: number, nextCursor: string | null) => ({ items: [project(index)], nextCursor });

const pageParts = (bodyBytes: number, index: number, nextCursor: string | null) => {
  const prefix = Buffer.from(JSON.stringify(createBudgetProjectPage(index, nextCursor)));
  const fillBytes = bodyBytes - prefix.length;
  requireCondition(fillBytes >= 0, "The streamed project page must contain complete legal JSON before its whitespace padding.");
  return { prefix, fillBytes };
};

const streamPage = async (response: ServerResponse, bodyBytes: number, index: number, nextCursor: string | null, receipt: BudgetProbeReceipt): Promise<void> => {
  const { prefix, fillBytes } = pageParts(bodyBytes, index, nextCursor);
  receipt.responseBodyBytes.push(bodyBytes);
  async function* chunks() {
    receipt.generatedDecodedBytes += prefix.length;
    yield prefix;
    for (let remaining = fillBytes; remaining > 0;) {
      const chunk = filler.subarray(0, Math.min(remaining, filler.length));
      receipt.generatedDecodedBytes += chunk.length;
      remaining -= chunk.length;
      yield chunk;
    }
  }
  response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
  const countWireBytes = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receipt.compressedBytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(Readable.from(chunks()), createGzip(), countWireBytes, response);
  receipt.completedPages += 1;
};

const expectedDisconnect = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error
  && ["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED"].includes(String(error.code));

type TerminateInstalledProcess = typeof import("../test/fixtures/installed-cli.js").terminateInstalledProcess;

export const budgetChildEnvironment = (environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() !== "DN_CONFIG_DIR")),
  HOME: home, USERPROFILE: home,
});

const runInstalledList = async (installed: InstalledCliReceipt, home: string, cwd: string, watchdogMs: number, receipt: BudgetProbeReceipt, terminate: TerminateInstalledProcess, preload: string | undefined, serverToken: string, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  const started = performance.now();
  const child = spawn(installed.nodePath, [...(preload === undefined ? [] : ["--import", preload]), installed.entryPath, "project", "list", "--json"], {
    cwd, env: budgetChildEnvironment(process.env, home), windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  const stdout: Buffer[] = [];
  let stderrBytes = 0;
  let launchFailure: unknown;
  child.once("error", (error) => { launchFailure = error; });
  const spawned = new Promise<void>((resolve) => { child.once("spawn", resolve); child.once("error", () => resolve()); });
  const closed = new Promise<void>((resolve) => child.once("close", (code, childSignal) => {
    receipt.elapsedMs = Math.round(performance.now() - started);
    receipt.exitCode = code;
    receipt.signal = childSignal;
    receipt.stderr = Buffer.concat(stderr).toString("utf8");
    receipt.stdout = Buffer.concat(stdout).toString("utf8");
    if (receipt.stderr.includes(serverToken) || receipt.stdout.includes(serverToken)) {
      receipt.stderr = "";
      receipt.stdout = "";
      stop(new Error("The installed CLI exposed its credential in captured output."));
    }
    receipt.childReaped = true;
    resolve();
  }));
  const stopping = Promise.withResolvers<Error>();
  const stop = stopping.resolve;
  child.stdout.on("data", (chunk: Buffer) => {
    receipt.stdoutBytes += chunk.length;
    if (receipt.stdoutBytes > outputLimit) stop(new Error("The failing installed CLI emitted more than 64 KiB of stdout."));
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > outputLimit) stop(new Error("The installed CLI exceeded the diagnostic capture limit."));
    else stderr.push(chunk);
  });
  const cancel = (): void => stop(new Error("Installed CLI acceptance was cancelled.", { cause: signal?.reason }));
  signal?.addEventListener("abort", cancel, { once: true });
  const watchdog = setTimeout(() => stop(new Error("The installed CLI exceeded the outer acceptance watchdog.")), watchdogMs);
  if (signal?.aborted) cancel();
  try {
    const failure = await Promise.race([closed.then(() => undefined), stopping.promise]);
    if (failure !== undefined) {
      try { await spawned; await terminate(child, closed); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError], "Installed CLI acceptance and cleanup failed."); }
      throw failure;
    }
    if (launchFailure !== undefined) throw launchFailure;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", cancel);
  }
};

type ProbeDefinition = {
  name: string;
  expected: { exitCode: 0; stdout: string } | { exitCode: 1; reason: string };
  watchdogMs: number;
  minimumMs?: number;
  deadlineLimits?: DeadlineLimits;
  expectedRequests?: number;
  handle(response: ServerResponse, index: number, receipt: BudgetProbeReceipt): Promise<void>;
  verify(receipt: BudgetProbeReceipt): void;
};

const progressPage: ProbeDefinition = {
  name: "command-deadline-with-progress",
  expected: { exitCode: 1, reason: "Operation deadline exceeded." },
  watchdogMs: 10_000,
  minimumMs: deadlineLimits.totalMs,
  deadlineLimits,
  handle: (response, index, receipt) => new Promise<void>((resolve) => {
    const done = (): void => { clearTimeout(timer); response.removeListener("close", done); resolve(); };
    const timer = setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ items: [project(index)], nextCursor: `page-${index + 1}` }));
        receipt.completedPages += 1;
      }
      done();
    }, 25);
    response.once("close", done);
  }),
  verify: (receipt) => {
    requireCondition(receipt.completedPages > 10, "The command-deadline probe must make sustained valid pagination progress.");
    requireCondition(receipt.requests - receipt.completedPages <= 1, "Only the final pagination request may be interrupted.");
  },
};
const stalledBody: ProbeDefinition = {
  name: "request-deadline-after-headers",
  expected: { exitCode: 1, reason: "HTTP request deadline exceeded." },
  watchdogMs: 10_000,
  minimumMs: deadlineLimits.requestMs,
  deadlineLimits,
  expectedRequests: 1,
  handle: async (response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    response.write('{"items":[');
  },
  verify: () => {},
};
const singleResponse = (overLimit: boolean): ProbeDefinition => ({
  name: overLimit ? "decoded-single-response-over-limit" : "decoded-single-response-at-limit",
  expected: overLimit ? { exitCode: 1, reason: "HTTP response byte limit exceeded." } : { exitCode: 0, stdout: `${JSON.stringify([project(1)])}\n` },
  watchdogMs: 60_000,
  expectedRequests: 1,
  handle: (response, index, receipt) => streamPage(response, responseLimit + Number(overLimit), index, null, receipt),
  verify: (receipt) => {
    requireCondition(receipt.responseBodyBytes[0] === responseLimit + Number(overLimit), "The single response must match its exact 128 MiB boundary case.");
    requireCondition(receipt.compressedBytes < responseLimit, "The gzip wire representation must remain below the decoded response limit.");
    if (!overLimit) requireCondition(receipt.generatedDecodedBytes === responseLimit && receipt.completedPages === 1, "The exact-limit success must consume one complete 128 MiB response.");
  },
});
const cumulativeResponses = (overLimit: boolean): ProbeDefinition => ({
  name: overLimit ? "decoded-cumulative-response-over-limit" : "decoded-cumulative-response-at-limit",
  expected: overLimit ? { exitCode: 1, reason: "Operation response byte budget exceeded." } : { exitCode: 0, stdout: `${JSON.stringify([project(1), project(2), project(3)])}\n` },
  watchdogMs: 150_000,
  expectedRequests: 3,
  handle: (response, index, receipt) => {
    requireCondition(index <= 3, "The cumulative boundary probe must finish in exactly three pages.");
    return streamPage(response, index < 3 ? 96 * mib : 64 * mib + Number(overLimit), index, index < 3 ? `page-${index + 1}` : null, receipt);
  },
  verify: (receipt) => {
    requireCondition(receipt.responseBodyBytes.length === 3 && receipt.responseBodyBytes.every((bytes) => bytes < responseLimit), "Every cumulative-budget page must stay below the single-response limit.");
    requireCondition(receipt.responseBodyBytes.reduce((sum, bytes) => sum + bytes, 0) === totalLimit + Number(overLimit), "The cumulative stream must match its exact 256 MiB boundary case.");
    requireCondition(receipt.compressedBytes < totalLimit, "The gzip wire representation must remain below the decoded cumulative limit.");
    if (!overLimit) requireCondition(receipt.generatedDecodedBytes === totalLimit && receipt.completedPages === 3, "The exact-limit success must consume all three complete pages.");
  },
});

export class BudgetAcceptanceError extends AggregateError {
  readonly receipts: BudgetProbeReceipt[];

  constructor(receipts: BudgetProbeReceipt[], errors: unknown[]) {
    super(errors, "Installed CLI production resource-budget acceptance failed.");
    this.receipts = receipts;
    this.name = "BudgetAcceptanceError";
  }
}

const runProbe = async (definition: ProbeDefinition, installed: InstalledCliReceipt, temporaryRoot: string, terminate: TerminateInstalledProcess, serverToken: string, signal?: AbortSignal): Promise<{ receipt: BudgetProbeReceipt; errors: unknown[] }> => {
  const receipt: BudgetProbeReceipt = {
    name: definition.name, passed: false, elapsedMs: 0, requests: 0, bearerRequests: 0, credentialSource: "normal-uniauth-session-pat", authenticationScope: "bearer-transport-only", completedPages: 0, uniqueCursors: 0,
    deadlines: { ...(definition.deadlineLimits ?? { totalMs, requestMs }), mocked: definition.deadlineLimits !== undefined },
    responseBodyBytes: [], generatedDecodedBytes: 0, compressedBytes: 0,
    exitCode: null, signal: null, stdoutBytes: 0, stdout: "", stderr: "", childReaped: false,
    socketsClosed: false, serverClosed: false, fixtureRemoved: false, failures: [],
  };
  const errors: unknown[] = [];
  const fail = (error: unknown): void => { errors.push(error); receipt.failures.push(describeAcceptanceError(error)); };
  let fixture: string | undefined;
  const sockets = new Set<Socket>();
  const handlers = new Set<Promise<void>>();
  const cursors = new Set<string>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const handle = async (): Promise<void> => {
      receipt.requests += 1;
      const index = receipt.requests;
      requireCondition(request.headers.authorization === `Bearer ${serverToken}`, "The installed CLI must attach its normally issued PAT to every budget transport request.");
      receipt.bearerRequests += 1;
      const url = new URL(request.url!, "http://127.0.0.1");
      requireCondition(request.method === "GET" && url.pathname === "/api/v1/projects" && url.searchParams.get("limit") === "100", "The installed CLI must use the real paginated project-list endpoint.");
      const cursor = url.searchParams.get("cursor") ?? "";
      requireCondition(cursor === (index === 1 ? "" : `page-${index}`), "The installed CLI retried or changed the expected pagination cursor.");
      requireCondition(!cursors.has(cursor), "A pagination cursor was requested more than once.");
      cursors.add(cursor);
      receipt.uniqueCursors = cursors.size;
      await definition.handle(response, index, receipt);
    };
    const pending = handle().catch((error: unknown) => {
      if (!(response.destroyed && expectedDisconnect(error))) fail(error);
      response.destroy();
    });
    handlers.add(pending);
    void pending.finally(() => { handlers.delete(pending); });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => { sockets.delete(socket); }); });
  try {
    signal?.throwIfAborted();
    fixture = await mkdtemp(path.join(temporaryRoot, `${definition.name}-`));
    const home = path.join(fixture, "home");
    await mkdir(path.join(home, ".daynight"), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The controlled HTTP server did not acquire a TCP port.");
    await writeFile(path.join(home, ".daynight/config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: ${JSON.stringify(serverToken)}\n`, { mode: 0o600 });
    let preload: string | undefined;
    if (definition.deadlineLimits !== undefined) {
      const mock: typeof import("../test/fixtures/installed-operation-limits.js") = await import(new URL("../test/fixtures/installed-operation-limits.ts", import.meta.url).href);
      preload = await mock.createInstalledDeadlineMock(fixture, installed.entryPath, definition.deadlineLimits);
    }
    console.log(`Checking installed CLI resource budget: ${definition.name}.`);
    await runInstalledList(installed, home, fixture, definition.watchdogMs, receipt, terminate, preload, serverToken, signal);
    requireCondition(receipt.exitCode === definition.expected.exitCode && receipt.signal === null, `${definition.name} must exit ${definition.expected.exitCode}.\n${receipt.stderr}`);
    if (definition.expected.exitCode === 1) {
      requireCondition(receipt.stdoutBytes === 0, `${definition.name} must not emit a partial JSON result.`);
      requireCondition(receipt.stderr.includes(definition.expected.reason), `${definition.name} did not report ${definition.expected.reason}\n${receipt.stderr}`);
    } else {
      requireCondition(receipt.stdout === definition.expected.stdout && receipt.stderr === "", `${definition.name} must return the complete successful JSON result without diagnostics.`);
    }
    if (definition.minimumMs !== undefined) requireCondition(receipt.elapsedMs >= definition.minimumMs, `${definition.name} completed before its configured deadline.`);
    if (definition.expectedRequests !== undefined) requireCondition(receipt.requests === definition.expectedRequests, `${definition.name} made an unexpected request count.`);
    requireCondition(receipt.requests === receipt.uniqueCursors, `${definition.name} must not retry a request.`);
    requireCondition(receipt.bearerRequests === receipt.requests, "Every budget request must carry the expected normally issued PAT.");
    definition.verify(receipt);
    await Promise.all([...handlers]);
    // The child has exited; all of its sockets must close without the fixture forcing them shut.
    await new Promise<void>((resolve, reject) => {
      if (sockets.size === 0) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error("The installed CLI retained an HTTP socket after it exited.")), 2_000);
      const check = (): void => { if (sockets.size === 0) { clearTimeout(timer); resolve(); } };
      for (const socket of sockets) socket.once("close", check);
    });
    receipt.socketsClosed = sockets.size === 0;
  } catch (error) {
    fail(error);
  } finally {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
        server.closeAllConnections();
      });
      await Promise.all([...handlers]);
      receipt.serverClosed = true;
    } catch (error) { fail(error); }
    try {
      if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
      receipt.fixtureRemoved = true;
    }
    catch (error) { fail(error); }
  }
  receipt.passed = receipt.failures.length === 0 && receipt.childReaped && receipt.socketsClosed && receipt.serverClosed && receipt.fixtureRemoved;
  console.log(`${receipt.passed ? "PASS" : "FAIL"} installed CLI resource budget ${receipt.name}: ${receipt.elapsedMs} ms, ${receipt.requests} requests.`);
  return { receipt, errors };
};

export type BudgetProbeSuite = "deadlines" | "stress-budgets";
const probeDefinitions: Record<BudgetProbeSuite, readonly ProbeDefinition[]> = {
  deadlines: [progressPage, stalledBody],
  "stress-budgets": [singleResponse(false), singleResponse(true), cumulativeResponses(false), cumulativeResponses(true)],
};

export const budgetProbeNames = (suite: BudgetProbeSuite): readonly string[] => probeDefinitions[suite].map((definition) => definition.name);

export const runBudgetProbes = async (suite: BudgetProbeSuite, installed: InstalledCliReceipt, repositoryRoot: string, serverToken: string, signal?: AbortSignal): Promise<BudgetProbeReceipt[]> => {
  if (suite === "stress-budgets" && process.env.CI) throw new Error("CLI resource-budget stress tests run only on local machines.");
  requireCondition(typeof serverToken === "string" && /^[\x21-\x7e]+$/.test(serverToken), "Budget probes require a header-safe PAT issued by the normal service fixture.");
  const fixture: typeof import("../test/fixtures/installed-cli.js") = await import(new URL("../test/fixtures/installed-cli.ts", import.meta.url).href);
  let temporaryRoot: string | undefined;
  const receipts: BudgetProbeReceipt[] = [];
  const errors: unknown[] = [];
  try {
    await mkdir(path.join(repositoryRoot, ".tmp"), { recursive: true });
    temporaryRoot = await mkdtemp(path.join(repositoryRoot, ".tmp/project-task-budgets-"));
    const run = async (definition: ProbeDefinition): Promise<void> => {
      try {
        const outcome = await runProbe(definition, installed, temporaryRoot!, fixture.terminateInstalledProcess, serverToken, signal);
        receipts.push(outcome.receipt);
        errors.push(...outcome.errors);
      } catch (error) { errors.push(error); }
    };
    if (suite === "stress-budgets") {
      // Full byte-boundary probes run serially so compression and parsing do not compete.
      for (const definition of probeDefinitions[suite]) await run(definition);
    } else {
      const outcomes = await Promise.allSettled(probeDefinitions[suite].map(run));
      for (const outcome of outcomes) if (outcome.status === "rejected") errors.push(outcome.reason);
    }
  } catch (error) { errors.push(error); }
  if (temporaryRoot !== undefined) {
    try { await rm(temporaryRoot, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
  }
  if (errors.length !== 0) throw new BudgetAcceptanceError(receipts, errors);
  return receipts;
};
