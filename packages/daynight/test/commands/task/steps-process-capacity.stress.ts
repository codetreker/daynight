import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { stringifyApiJson } from "../../../src/api/json.js";
import { TASK_STEPS_RESPONSE_BYTES } from "../../../src/api/task-steps.js";
import type { StepsResource, TaskStep } from "../../../src/api/types.js";

if (process.env.CI) throw new Error("CLI stress tests run only on local machines.");

it("reads the complete 64 MiB Steps collection through the CLI process", async () => {
  const projectId = "aaaaaaaa-1111-4111-8111-111111111111";
  const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
  const stamp = "2026-11-03T10:11:12.123456Z";
  const steps: TaskStep[] = Array.from({ length: 128 }, (_, index) => ({ id: index.toString(16).padStart(8, "0"), title: "<中文&>", description: "", status: "todo", createdAt: stamp, updatedAt: stamp }));
  const resource: StepsResource = { projectId, taskId, version: 9_223_372_036_854_775_807n, steps };
  let remaining = TASK_STEPS_RESPONSE_BYTES - Buffer.byteLength(stringifyApiJson(resource));
  for (const step of steps) {
    const length = Math.min(remaining, 524_288);
    (step as { description: string }).description = "X".repeat(length);
    remaining -= length;
  }
  expect(remaining).toBe(0);
  const wire = stringifyApiJson(resource);
  expect(Buffer.byteLength(wire)).toBe(TASK_STEPS_RESPONSE_BYTES);
  const expectedDigest = createHash("sha256").update(wire).update("\n").digest("hex");
  const temporary = fileURLToPath(new URL("../../../../../.tmp/", import.meta.url));
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "steps-capacity-process-"));
  const config = path.join(root, "home", ".daynight");
  const requests: { method: string | undefined; url: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "Content-Type": "application/json", "Daynight-User-ID": "cccccccc-3333-4333-8333-333333333333" });
    response.end(wire);
  });
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let exited = false;
  try {
    await mkdir(config, { recursive: true });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture address.");
    await writeFile(path.join(config, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
    const executable = fileURLToPath(new URL("../../../dist/main.js", import.meta.url));
    child = spawn(process.execPath, [executable, "task", "step", "list", taskId, "--project", projectId, "--json"], { cwd: root, env: { ...process.env, HOME: path.dirname(config), USERPROFILE: path.dirname(config), DN_CONFIG_DIR: config }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const digest = createHash("sha256"); let bytes = 0, stderrBytes = 0, stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; digest.update(chunk); });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderrBytes += Buffer.byteLength(chunk); stderr = (stderr + chunk).slice(0, 16_384); });
    let result!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    let failed!: (error: Error) => void;
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { result = resolve; failed = reject; });
    closed = new Promise<void>(resolve => { child!.once("close", (code, signal) => { exited = true; result({ code, signal }); resolve(); }); });
    child.once("error", failed);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Steps CLI capacity process timed out.")), 100_000); });
      expect(await Promise.race([completion, timeout])).toEqual({ code: 0, signal: null });
    } finally { if (timer !== undefined) clearTimeout(timer); }
    expect(stderrBytes, stderr).toBe(0);
    expect(bytes).toBe(TASK_STEPS_RESPONSE_BYTES + 1);
    expect(digest.digest("hex")).toBe(expectedDigest);
    expect(requests).toEqual([{ method: "GET", url: `/api/v1/projects/${projectId}/tasks/${taskId}/steps`, authorization: "Bearer fixture-token" }]);
  } finally {
    try {
      if (child !== undefined && closed !== undefined && !exited) {
        child.kill("SIGKILL");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Steps CLI capacity cleanup timed out.")), 5_000); })]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
    } finally {
      try {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Steps HTTP fixture cleanup timed out.")), 5_000);
          server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
        });
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}, 120_000);
