import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const executable = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const body = "Private message body that must not appear in output diagnostics.";

describe("compiled Thread receipt output", () => {
  it.skipIf(process.platform !== "linux")("reports a confirmed POST when production stdout fails asynchronously on /dev/full", async () => {
    const temporary = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, "thread-full-output-"));
    const configDirectory = path.join(directory, "config");
    const home = path.join(directory, "home");
    const requests: { method: string; url: string; authorization: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      request.on("end", () => {
        requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(201, { "Content-Type": "application/json", "Daynight-User-ID": userId });
        response.end(JSON.stringify({ id: messageId, author: { userId, displayName: null, Agent: false }, body, createdAt: "2026-11-03T10:20:30.000Z" }));
      });
    });
    let child: ReturnType<typeof spawn> | undefined;
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing Thread test HTTP listener.");
      await mkdir(configDirectory);
      await mkdir(home);
      await writeFile(path.join(configDirectory, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: fixture-token\n`);
      output = await open("/dev/full", "w");
      child = spawn(process.execPath, [executable, "task", "thread", "post", taskId, "--body", body, "--project", projectId], {
        cwd: directory,
        stdio: ["ignore", output.fd, "pipe"],
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DN_CONFIG_DIR: configDirectory },
      });
      const current = child;
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
        let stderr = "";
        let failure: Error | undefined;
        if (current.stderr === null) { reject(new Error("Missing compiled CLI stderr pipe.")); return; }
        current.stderr.setEncoding("utf8");
        current.stderr.on("data", (value: string) => { stderr += value; });
        current.once("error", (error) => { failure = error; });
        const timer = setTimeout(() => { failure = new Error("Compiled Thread stdout test exceeded its deadline."); current.kill("SIGKILL"); }, 20_000);
        current.once("close", (code, signal) => {
          clearTimeout(timer);
          if (failure !== undefined) reject(failure);
          else resolve({ code, signal, stderr });
        });
      });
      expect(result.code, result.stderr).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain(`Message posted. Id: ${messageId}`);
      expect(result.stderr).toContain("The message is confirmed, but local output failed.");
      expect(result.stderr).not.toMatch(/unknown|unhandled|node:events|\n\s+at\s|Caused by:/i);
      expect(result.stderr).not.toContain(body);
      expect(result.stderr).not.toContain("fixture-token");
      expect(requests).toEqual([{ method: "POST", url: `/api/v1/projects/${projectId}/tasks/${taskId}/thread/messages`, authorization: "Bearer fixture-token", body: JSON.stringify({ body }) }]);
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => { child!.once("close", () => resolve()); child!.kill("SIGKILL"); });
      }
      await output?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => { server.close((error) => error === undefined ? resolve() : reject(error)); });
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
