import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseApiJson, stringifyApiJson } from "../../src/api/json.js";
import { withTaskObservation } from "../fixtures/task-observation.js";

const projectId = "a1b2c3d4-1111-4222-8333-123456789abc";
const taskId = "b1b2c3d4-1111-4222-8333-123456789abc";
const time = "2026-10-20T00:00:00.123456789Z";
const project = { id: projectId, name: "Project", repoUrl: "git@example.com:org/repo.git", settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", version: 1n }, createdAt: time, updatedAt: time };
const task = { type: "task", parentId: null, id: taskId, projectId, title: "Race", description: "Preserved", tags: [], properties: {}, status: "in_progress", allowAgents: false, assignedTo: null, requiredPlatform: null, version: 9_007_199_254_740_994n, startedAt: time, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false };
const respond = (response: ServerResponse, body: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(stringifyApiJson(body)); };
type Request = { method: string; path: string; body: unknown };

const fixture = async (handler: (request: Request, response: ServerResponse) => void) => {
  const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "status-race-"));
  const home = path.join(root, "home");
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length ? parseApiJson(Buffer.concat(chunks).toString("utf8")) : null;
      const captured = { method: request.method!, path: request.url!, body };
      requests.push(captured);
      if (captured.method === "GET" && captured.path === `/api/v1/projects/${projectId}`) respond(response, project);
      else if (captured.method === "GET" && captured.path === `/api/v1/projects/${projectId}/tasks/${taskId}`) respond(response, task);
      else handler(captured, response);
    });
  });
  const children = new Set<ReturnType<typeof spawn>>();
  const close = async () => {
    const failures: unknown[] = [];
    const stopped = await Promise.allSettled([...children].map((child) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.off("close", onClose); reject(new Error("CLI cleanup timed out")); }, 5_000);
      const onClose = () => { clearTimeout(timer); resolve(); };
      child.once("close", onClose);
      try { child.kill("SIGKILL"); } catch (error) { clearTimeout(timer); child.off("close", onClose); reject(error); }
    })));
    for (const result of stopped) if (result.status === "rejected") failures.push(result.reason);
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("HTTP server cleanup timed out")), 5_000);
        server.close((error) => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      });
    } catch (error) { failures.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
    await mkdir(path.join(home, ".daynight"), { recursive: true });
    await writeFile(path.join(home, ".daynight", "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fixture initialization and cleanup failed"); }
    throw error;
  }
  const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
  const run = (args: string[], withVersion = true) => {
    const child = spawn(process.execPath, [executable, "task", ...args, "--project", projectId, ...(withVersion ? ["--if-version", "9007199254740993"] : [])], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "", stderr = "";
      let failure: Error | undefined;
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data: string) => { stdout += data; }); child.stderr.on("data", (data: string) => { stderr += data; });
      child.once("error", (error) => { failure = error; });
      const timer = setTimeout(() => {
        const timeout = new Error("CLI command timed out");
        try { child.kill("SIGKILL"); reject(timeout); } catch (error) { reject(new AggregateError([timeout, error], "CLI command timed out and termination failed")); }
      }, 20_000);
      child.once("close", (code) => { clearTimeout(timer); children.delete(child); if (failure) reject(failure); else resolve({ code, stdout, stderr }); });
    });
  };
  return { requests, run, close };
};

it.each([false, true])("keeps parallel status results with same-state=%s attached to each independent process", async (sameState) => {
  const pending: { response: ServerResponse; status: string }[] = [];
  const f = await fixture((request, response) => {
    if (request.method !== "PUT" || request.path !== `/api/v1/projects/${projectId}/tasks/${taskId}/status`) { respond(response, { error: { code: "not_found", message: "Unexpected request", requestId: "unexpected" } }, 404); return; }
    pending.push({ response, status: (request.body as { status: string }).status });
    if (pending.length === 2) {
      for (const [index, item] of pending.entries()) {
        if (sameState) { item.response.setHeader("X-Request-ID", `same-${index}`); respond(item.response, { ...task, version: 9_007_199_254_740_993n }); }
        else if (item.status === "in_progress") { item.response.setHeader("X-Request-ID", "winner-id"); respond(item.response, task); }
        else { item.response.setHeader("X-Request-ID", "conflict-id"); respond(item.response, { error: { code: "version_conflict", message: "Version conflict", requestId: "conflict-id" } }, 409); }
      }
    }
  });
  try {
    const [first, second] = await Promise.all([f.run(["set-status", taskId, "in_progress"]), f.run(["set-status", taskId, sameState ? "in_progress" : "done"])]);
    for (const result of sameState ? [first, second] : [first]) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Status: in_progress\n");
      expect(result.stdout).toContain(`Version: ${sameState ? "9007199254740993" : "9007199254740994"}\n`);
    }
    if (!sameState) {
      expect(second.code).toBe(1);
      expect(second.stdout).toBe("");
      expect(second.stderr).toContain("version_conflict");
      expect(second.stderr).toContain(taskId);
      expect(second.stderr).toContain("requestId=conflict-id");
      expect(second.stderr).not.toContain("winner-id");
    }
    expect(f.requests.filter(({ method }) => method === "GET")).toHaveLength(4);
    const writes = f.requests.filter(({ method }) => method === "PUT");
    expect(writes).toHaveLength(2);
    expect(writes.map(({ body }) => body)).toEqual(expect.arrayContaining([{ version: 9_007_199_254_740_993n, status: "in_progress" }, { version: 9_007_199_254_740_993n, status: sameState ? "in_progress" : "done" }]));
    expect(f.requests).toHaveLength(6);
  } finally { await f.close(); }
}, 60_000);

it("keeps returned external classification in a successful status response", async () => {
  const prerequisite = "b1b2c3d4-1111-4222-8333-123456789abd";
  const classified = { ...task, dependsOn: [prerequisite], externalDependsOn: [prerequisite] };
  const f = await fixture((request, response) => {
    if (request.method === "PUT" && request.path === `/api/v1/projects/${projectId}/tasks/${taskId}/status`) respond(response, classified);
    else respond(response, { error: { code: "not_found", message: "Unexpected request", requestId: "unexpected" } }, 404);
  });
  try {
    const result = await f.run(["set-status", taskId, "in_progress"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    for (const value of [`Depends on: ${prerequisite}\n`, `External dependencies (1): ${prerequisite}\n`, "Status: in_progress\n", "Version: 9007199254740994\n"]) expect(result.stdout).toContain(value);
    expect(f.requests).toEqual([
      { method: "GET", path: `/api/v1/projects/${projectId}`, body: null },
      { method: "GET", path: `/api/v1/projects/${projectId}/tasks/${taskId}`, body: null },
      { method: "PUT", path: `/api/v1/projects/${projectId}/tasks/${taskId}/status`, body: { version: 9_007_199_254_740_993n, status: "in_progress" } },
    ]);
  } finally { await f.close(); }
}, 60_000);

it("keeps a blocked todo resource returned by a same-status confirmation", async () => {
  const prerequisite = "b1b2c3d4-1111-4222-8333-123456789abd";
  const blocked = { ...task, status: "todo", ready: false, startedAt: null, version: 9_007_199_254_740_993n, dependsOn: [prerequisite], blockedBy: [prerequisite] };
  const f = await fixture((request, response) => {
    if (request.method === "PUT" && request.path === `/api/v1/projects/${projectId}/tasks/${taskId}/status`) respond(response, blocked);
    else respond(response, { error: { code: "not_found", message: "Unexpected request", requestId: "unexpected" } }, 404);
  });
  try {
    const result = await f.run(["set-status", taskId, "todo"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    for (const value of ["Status: todo\n", "Ready: false\n", `Depends on: ${prerequisite}\n`, `Blocked by: ${prerequisite}\n`, "Version: 9007199254740993\n"]) expect(result.stdout).toContain(value);
    expect(f.requests).toEqual([
      { method: "GET", path: `/api/v1/projects/${projectId}`, body: null },
      { method: "GET", path: `/api/v1/projects/${projectId}/tasks/${taskId}`, body: null },
      { method: "PUT", path: `/api/v1/projects/${projectId}/tasks/${taskId}/status`, body: { version: 9_007_199_254_740_993n, status: "todo" } },
    ]);
  } finally { await f.close(); }
}, 60_000);

it("keeps returned external classification on a task read after a property write", async () => {
  const prerequisite = "b1b2c3d4-1111-4222-8333-123456789abd";
  const properties = { pullRequests: [{ url: "reference", title: "Preserved" }] };
  const classified = { ...task, properties, dependsOn: [prerequisite], externalDependsOn: [prerequisite] };
  const f = await fixture((request, response) => {
    if (request.method === "PUT" && request.path === `/api/v1/projects/${projectId}/tasks/${taskId}/properties/pullRequests`) respond(response, { projectId, taskId, version: classified.version, properties });
    else if (request.method === "GET" && request.path === `/api/v1/projects/${projectId}/tasks/${taskId}?include=session`) respond(response, withTaskObservation(classified));
    else respond(response, { error: { code: "not_found", message: "Unexpected request", requestId: "unexpected" } }, 404);
  });
  try {
    const value = JSON.stringify(properties.pullRequests);
    const written = await f.run(["set-property", taskId, "pullRequests", value]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stderr).toBe("");
    const shown = await f.run(["show", taskId, "--json"], false);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stderr).toBe("");
    expect(parseApiJson(shown.stdout)).toEqual(withTaskObservation(classified));
    expect(f.requests).toEqual([
      { method: "PUT", path: `/api/v1/projects/${projectId}/tasks/${taskId}/properties/pullRequests`, body: { version: 9_007_199_254_740_993n, valueText: value } },
      { method: "GET", path: `/api/v1/projects/${projectId}`, body: null },
      { method: "GET", path: `/api/v1/projects/${projectId}/tasks/${taskId}?include=session`, body: null },
    ]);
  } finally { await f.close(); }
}, 60_000);

it.each(["property", "metadata", "status"] as const)("preserves nonempty PRs and execution timestamps through a %s response", async (action) => {
  const startedAt = "2026-10-19T23:00:00.123456789Z";
  const properties = { pullRequests: [{ url: "opaque 中文", title: "First\nline" }, { url: "opaque 中文", title: "First\nline" }] };
  const original = { ...task, startedAt, version: 9_007_199_254_740_993n, properties };
  const returned = action === "property" ? original : action === "metadata" ? { ...original, description: "Updated metadata", version: original.version + 1n } : { ...original, status: "done", completedAt: time, version: original.version + 1n };
  const resourcePath = `/api/v1/projects/${projectId}/tasks/${taskId}`;
  const f = await fixture((request, response) => {
    if (request.method === "GET" && request.path === `${resourcePath}?include=session`) respond(response, withTaskObservation(returned));
    else if (action === "property" && request.method === "PUT" && request.path === `${resourcePath}/properties/pullRequests`) respond(response, { projectId, taskId, version: original.version, properties });
    else if (action === "metadata" && request.method === "PATCH" && request.path === resourcePath) respond(response, returned);
    else if (action === "status" && request.method === "PUT" && request.path === `${resourcePath}/status`) respond(response, returned);
    else respond(response, { error: { code: "not_found", message: "Unexpected request", requestId: "unexpected" } }, 404);
  });
  try {
    const raw = JSON.stringify(properties.pullRequests);
    const args = action === "property" ? ["set-property", taskId, "pullRequests", raw] : action === "metadata" ? ["update", taskId, "--description", "Updated metadata"] : ["set-status", taskId, "done"];
    const changed = await f.run(args);
    expect(changed.code, changed.stderr).toBe(0);
    expect(changed.stderr).toBe("");
    expect(changed.stdout).toContain('"url":"opaque 中文","title":"First\\nline"');
    expect(changed.stdout).toContain(`Version: ${returned.version}\n`);
    const shown = await f.run(["show", taskId, "--json"], false);
    expect(shown.code, shown.stderr).toBe(0);
    expect(parseApiJson(shown.stdout)).toEqual(withTaskObservation(returned));
    const write = action === "property"
      ? { method: "PUT", path: `${resourcePath}/properties/pullRequests`, body: { version: original.version, valueText: raw } }
      : action === "metadata"
        ? { method: "PATCH", path: resourcePath, body: { version: original.version, description: "Updated metadata" } }
        : { method: "PUT", path: `${resourcePath}/status`, body: { version: original.version, status: "done" } };
    expect(f.requests).toEqual([
      ...(action === "property" ? [] : [{ method: "GET", path: `/api/v1/projects/${projectId}`, body: null }]), ...(action === "status" ? [{ method: "GET", path: resourcePath, body: null }] : []), write,
      { method: "GET", path: `/api/v1/projects/${projectId}`, body: null },
      { method: "GET", path: `${resourcePath}?include=session`, body: null },
    ]);
  } finally { await f.close(); }
}, 60_000);

it.each([
  { options: ["--required-platform", "windows", "--title", "Must not save"], update: { requiredPlatform: "windows", title: "Must not save" } },
  { options: ["--clear-required-platform"], update: { requiredPlatform: null } },
])("reports an in-progress platform refusal without replaying: $options", async ({ options, update }) => {
  const f = await fixture((request, response) => {
    if (request.method === "PATCH" && request.path === `/api/v1/projects/${projectId}/tasks/${taskId}`) respond(response, { error: { code: "invalid_transition", message: "Cannot change platform while in progress", requestId: "platform-refusal-id" } }, 409);
    else respond(response, { error: { code: "not_found", message: "Unexpected request", requestId: "unexpected" } }, 404);
  });
  try {
    const result = await f.run(["update", taskId, ...options]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid_transition");
    expect(result.stderr).toContain(taskId);
    expect(result.stderr).toContain("requestId=platform-refusal-id");
    expect(f.requests).toEqual([
      { method: "GET", path: `/api/v1/projects/${projectId}`, body: null },
      { method: "PATCH", path: `/api/v1/projects/${projectId}/tasks/${taskId}`, body: { version: 9_007_199_254_740_993n, ...update } },
    ]);
  } finally { await f.close(); }
}, 60_000);

it.each([
  { args: ["update", taskId, "--external-depends-on", "b1b2c3d4-1111-4222-8333-123456789abd"], method: "PATCH", suffix: "", body: { version: 9_007_199_254_740_993n, dependsOn: ["b1b2c3d4-1111-4222-8333-123456789abd"], externalDependsOn: ["b1b2c3d4-1111-4222-8333-123456789abd"] }, code: "version_conflict" },
  { args: ["set-status", taskId, "in_progress"], method: "PUT", suffix: "/status", body: { version: 9_007_199_254_740_993n, status: "in_progress" }, code: "dependency_unsatisfied" },
])("reports an external-dependency $code without replaying", async ({ args, method, suffix, body, code }) => {
  const prerequisite = "b1b2c3d4-1111-4222-8333-123456789abd";
  const f = await fixture((request, response) => {
    if (request.method === method && request.path === `/api/v1/projects/${projectId}/tasks/${taskId}${suffix}`) respond(response, { error: { code, message: "Dependency change refused", requestId: "external-refusal-id", details: { taskIds: [prerequisite] } } }, 409);
    else respond(response, { error: { code: "not_found", message: "Unexpected request", requestId: "unexpected" } }, 404);
  });
  try {
    const result = await f.run(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    for (const value of [code, taskId, prerequisite, "requestId=external-refusal-id"]) expect(result.stderr).toContain(value);
    expect(f.requests).toEqual([
      { method: "GET", path: `/api/v1/projects/${projectId}`, body: null },
      ...(method === "PUT" ? [{ method: "GET", path: `/api/v1/projects/${projectId}/tasks/${taskId}`, body: null }] : []),
      { method, path: `/api/v1/projects/${projectId}/tasks/${taskId}${suffix}`, body },
    ]);
  } finally { await f.close(); }
}, 60_000);
