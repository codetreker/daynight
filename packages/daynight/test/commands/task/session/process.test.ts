import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { actorId, inspection, operationId, projectId, receipt, sessionId, taskId } from "./fixtures.js";
let root: string;
beforeAll(async () => { const tmp = fileURLToPath(new URL("../../../../../../.tmp/", import.meta.url)); await mkdir(tmp, { recursive: true }); root = await mkdtemp(path.join(tmp, "session-process-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
it("runs the compiled CLI against real HTTP, loses the POST response and recovers in another process without POST", async () => {
  const state = await mkdtemp(path.join(root, "config-"));
  const requests: { method: string; url: string; body: string }[] = [];
  let accepted = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push({ method: request.method!, url: request.url!, body: Buffer.concat(chunks).toString("utf8") });
      response.setHeader("Content-Type", "application/json"); response.setHeader("Daynight-User-ID", actorId);
      if (request.url === "/api/v1/me") { response.end(JSON.stringify({ id: actorId, name: null, email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "personal", name: null } })); return; }
      if (request.url!.endsWith("/inspection")) { response.end(JSON.stringify(inspection)); return; }
      if (request.method === "POST") { accepted = true; request.socket.destroy(); return; }
      if (!accepted) { response.statusCode = 404; response.end(JSON.stringify({ error: { code: "not_found", message: "absent", requestId: operationId } })); return; }
      response.end(JSON.stringify({ operation: receipt("provider_accepted", { providerResult: "started" }), currentBinding: false }));
    });
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing test port");
  await writeFile(path.join(state, "config.yml"), `serverUrl: http://127.0.0.1:${address.port}\nserverToken: test-token\n`);
  const invoke = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const cli = fileURLToPath(new URL("../../../../dist/main.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "task", "session", ...args], { env: { ...process.env, DN_CONFIG_DIR: state }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); }); child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  try {
    const args = ["send", taskId, sessionId, "--project", projectId, "--operation-id", operationId, "--text", "\ufeff/compact\r\nexact\n", "--wait-seconds", "0", "--json"];
    const first = await invoke(args); expect(first.code, first.stderr).toBe(3); expect(JSON.parse(first.stdout)).toMatchObject({ state: "unknown", operationId });
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(JSON.parse(requests.find(request => request.method === "POST")!.body)).toMatchObject({ payload: { content: [{ type: "text", text: "\ufeff/compact\r\nexact\n" }], expectedTurnId: null } });
    requests.length = 0;
    const second = await invoke(args); expect(second.code, second.stderr).toBe(0); expect(JSON.parse(second.stdout)).toMatchObject({ state: "provider_accepted", operationId, currentBinding: false });
    expect(requests.map(request => request.method)).toEqual(["GET", "GET"]); expect(requests.some(request => request.url.endsWith("/inspection"))).toBe(false);
    requests.length = 0;
    const third = await invoke(["operation", "--operation-id", operationId, "--json"]); expect(third.code, third.stderr).toBe(0); expect(requests.map(request => request.method)).toEqual(["GET", "GET"]);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
