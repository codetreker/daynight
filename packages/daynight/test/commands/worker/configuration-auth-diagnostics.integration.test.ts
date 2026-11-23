import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { tryAcquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";

it.each([401, 403])("writes the terminal %s authority refusal through actual runtime and JSONL without retrying", async status => {
  const base = path.resolve(".tmp/worker-configuration-auth-diagnostics");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "w-")), previous = process.env.DN_CONFIG_DIR;
  process.env.DN_CONFIG_DIR = path.join(root, "state");
  const paths = resolveWorkerPaths(root), requestId = `authority-refusal-${status}`;
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: status === 401 ? "unauthenticated" : "forbidden", requestId, message: "private server response" } }), {
    status, headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
  }));
  try {
    await mkdir(paths.stateDirectory, { recursive: true });
    await writeFile(paths.configFile, JSON.stringify({ serverUrl: "http://127.0.0.1:19099", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: "33333333-3333-4333-8333-333333333333", worker: { repositories: [] } }));
    await expect(runWorker({ homeDirectory: root, workingDirectory: root, packageDirectory: path.resolve("."), version: "9.8.7", log: () => {} })).rejects.toMatchObject({ name: "ApiError", phase: "response", status });
    expect(fetch).toHaveBeenCalledOnce();
    const records: { kind: string; configuration?: { phase: string; status: string; reason?: string; requestId?: string; remote: string; local: string; nextAttemptAt: string | null } }[] = [];
    for (const filename of await readdir(paths.logsDirectory)) for (const line of (await readFile(path.join(paths.logsDirectory, filename), "utf8")).trim().split("\n")) if (line.length !== 0) records.push(JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({ kind: "worker-configuration-failed", configuration: expect.objectContaining({
      phase: "authority-read", status: "failed", reason: status === 401 ? "authentication_required" : "permission_denied", requestId, remote: "rejected", local: "not_attempted", nextAttemptAt: null,
    }) }));
    expect(JSON.stringify(records)).not.toContain("private server response");
    const next = await tryAcquireWorkerInstanceLock(paths);
    try { expect(next).not.toBeNull(); } finally { await next?.release(); }
  } finally {
    fetch.mockRestore();
    if (previous === undefined) delete process.env.DN_CONFIG_DIR; else process.env.DN_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
