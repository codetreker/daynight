import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const input = JSON.parse(readFileSync(0, "utf8"));
const entry = process.argv[2];
const daemon = process.argv[3];
const root = path.join(process.cwd(), "worker-runtime");
const eventsFile = path.join(root, "events.jsonl");
const bin = path.join(root, "bin"), codex = path.join(root, "codex"), config = path.join(root, ".daynight");
const logs = [];
const wire = [];
let running;
let interrupted = false;
for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => { interrupted = true; if (running?.exitCode === null) running.kill("SIGINT"); });
const proxy = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = { ...request.headers }; delete headers.host; delete headers.connection;
    const result = await fetch(input.serverUrl + request.url, { method: request.method, headers, ...(body.length === 0 ? {} : { body }) });
    if (request.method === "POST" && request.url.endsWith("/report")) wire.push({ kind: "report", path: request.url, body: JSON.parse(body), status: result.status });
    if (request.method === "POST" && request.url.endsWith("/worker-claim")) wire.push({ kind: "claim", path: request.url, status: result.status });
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) { response.writeHead(500); response.end(); logs.push(`proxy failure: ${error.message}`); }
});
const headers = { Authorization: `Bearer ${input.aliceToken}`, "Content-Type": "application/json", "Daynight-Worker-Protocol": "2" };
const request = async (method, endpoint, body) => {
  const response = await fetch(input.serverUrl + endpoint, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`fixture service ${method} failed: ${response.status}`);
  return response.status === 204 ? undefined : await response.json();
};
const readTask = taskId => request("GET", `/api/v1/projects/${input.b.id}/tasks/${taskId}`);
const enable = async taskId => { const task = await readTask(taskId); await request("PATCH", `/api/v1/projects/${input.b.id}/tasks/${taskId}`, { version: task.version, allowAgents: true }); };
const admin = async (method, endpoint, body, expected) => {
  const result = await fetch(input.serverUrl + endpoint, { method, headers: { Authorization: `Bearer ${input.bobToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(result.status, expected);
  return expected === 204 ? undefined : await result.json();
};
const restore = async () => {
  const invitation = await admin("POST", `/api/v1/projects/${input.a.id}/invitations`, { expectedUserId: input.bobId }, 201);
  const accepted = await request("POST", "/api/v1/invitations/accept", { token: new URL(invitation.link).hash.slice(1), expectedUserId: input.aliceId });
  return accepted.directGrant.version;
};
const revoke = version => admin("DELETE", `/api/v1/projects/${input.a.id}/members/${input.aliceId}`, { version, expectedUserId: input.bobId }, 204);
const events = async () => { try { const text = await readFile(eventsFile, "utf8"); return text.split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
const wait = async (label, condition) => {
  const deadline = Date.now() + 30000;
  while (!await condition()) {
    if (interrupted) throw new Error("fixture interrupted");
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${logs.slice(-20).join("")} ${JSON.stringify(await events())}`);
    if (running?.exitCode !== null) throw new Error(`worker exited during ${label}: ${logs.slice(-20).join("")}`);
    await sleep(50);
  }
};
const stop = async () => {
  if (!running || running.exitCode !== null) return;
  const child = running; const closed = new Promise((resolve, reject) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  child.kill("SIGINT");
  const result = await Promise.race([closed, sleep(10000, undefined, { ref: false }).then(() => { throw new Error("worker stop timed out"); })]);
  assert.deepEqual(result, { code: 0, signal: null }); running = undefined;
};
try {
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  await mkdir(bin, { recursive: true }); await mkdir(codex); await mkdir(config);
  process.chdir(root);
  const hook = path.join(codex, "herdr-agent-state.sh");
  await writeFile(hook, "# fixture integration metadata\n");
  await writeFile(path.join(codex, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `bash '${hook}' session` }] }] } }));
  await writeFile(path.join(bin, "herdr"), await readFile(daemon), { mode: 0o700 });
  await writeFile(path.join(bin, "codex"), "#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.includes('--version'))console.log('codex-cli 0.164.0');else if(a.includes('--help'))console.log('--no-daemon --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust');else if(a.includes('features'))console.log('hooks stable true');else throw Error('unexpected fixture command');\n", { mode: 0o700 });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|COPILOT_|CODEX_|HERDR_|DAYNIGHT_|NODE_OPTIONS$)/i.test(key)) delete environment[key];
  // The runner stays in this cwd until its children finish. This proc alias
  // keeps Unix socket names short while all owned data stays in the fixture.
  Object.assign(environment, { HOME: root, USERPROFILE: root, DN_CONFIG_DIR: `/proc/${process.pid}/cwd/.daynight`, XDG_CONFIG_HOME: path.join(root, "xdg"), CODEX_HOME: codex, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", FIXTURE_EVENTS: eventsFile, FIXTURE_SQLITE: createRequire(await realpath(entry)).resolve("better-sqlite3"), FIXTURE_SERVER: input.serverUrl, FIXTURE_TOKEN: input.aliceToken, FIXTURE_HOLD_TASK: input.taskIds[3] });
  const repositories = [];
  for (const [index, project] of [input.a, input.b].entries()) {
    const repo = path.join(root, `r${index}`); await mkdir(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, env: environment, stdio: "pipe", timeout: 10000 });
    git("init", "--initial-branch=main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("remote", "add", "origin", project.repoUrl);
    await writeFile(path.join(repo, "README.md"), "fixture\n"); git("add", "README.md"); git("commit", "-m", "Fixture");
    repositories.push({ remote: project.repoUrl, path: repo, projectId: project.id });
  }
  await writeFile(path.join(config, "config.yml"), JSON.stringify({ serverUrl: proxyOrigin, serverToken: input.aliceToken, worker: { agent: "codex", model: "fixture-model", maxConcurrent: 1, pollIntervalMs: 50, repositories } }));
  const start = () => {
    running = spawn(process.execPath, [entry, "worker", "run"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    running.stdout.on("data", value => logs.push(value.toString())); running.stderr.on("data", value => logs.push(value.toString()));
  };
  const control = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  const complete = async taskId => {
    await wait(`agent completion ${taskId}`, async () => (await events()).some(event => event.kind === "agent-completed" && event.taskId === taskId));
    assert.equal((await readTask(taskId)).status, "done");
    await wait(`cleanup ${taskId}`, async () => (await events()).some(event => event.kind === "workspace-close" && event.taskId === taskId));
  };
  start(); await complete(input.taskIds[0]);
  assert.ok(wire.some(event => event.kind === "report" && event.status === 200));
  assert.ok(wire.filter(event => event.kind === "report" && event.status === 200).every(event => event.body.taskInventory === null));
  const workerId = wire.find(event => event.kind === "report" && event.status === 200).path.split("/").at(-2);
  const firstRestoration = wire.length;
  let version = await restore();
  await wait("complete inventory after restoration", () => wire.slice(firstRestoration).some(event => event.kind === "report" && event.status === 200 && event.body.taskInventory !== null));
  const selection = () => request("GET", `/api/v1/me/workers/${workerId}/configuration`);
  await wait("A and B cloud selection", async () => { const configuration = await selection(); return configuration.desired?.value.projects.some(project => project.projectId === input.a.id) && configuration.desired.value.projects.some(project => project.projectId === input.b.id); });
  await revoke(version);
  const partialStart = wire.length;
  await wait("partial inventory report", () => wire.slice(partialStart).some(event => event.kind === "report" && event.status === 200 && event.body.taskInventory === null));
  assert.ok((await selection()).desired.value.projects.some(project => project.projectId === input.a.id));
  const partialObserved = wire.findIndex((event, index) => index >= partialStart && event.kind === "report" && event.status === 200 && event.body.taskInventory === null);
  await enable(input.taskIds[1]); await complete(input.taskIds[1]);
  const claimIndex = wire.findIndex((event, index) => index >= partialStart && event.kind === "claim" && event.path.includes(input.taskIds[1]) && event.status === 200);
  assert.ok(claimIndex >= partialStart);
  await wait("telemetry after partial claim", () => wire.slice(claimIndex + 1).some(event => event.kind === "report" && event.status === 200 && event.body.taskInventory === null));
  assert.ok(wire.slice(partialObserved).filter(event => event.kind === "report" && event.status === 200).every(event => event.body.taskInventory === null));
  const restoredStart = wire.length; version = await restore();
  await wait("complete inventory after partial claim", () => wire.slice(restoredStart).some(event => event.kind === "report" && event.status === 200 && event.body.taskInventory !== null));
  await stop();
  await revoke(version);
  await enable(input.taskIds[2]); start(); await complete(input.taskIds[2]);
  await enable(input.taskIds[3]);
  await wait("held B native assignment", async () => (await events()).some(event => event.kind === "agent-held" && event.taskId === input.taskIds[3]) && (await readTask(input.taskIds[3])).properties.worker?.nativeSessionId);
  await stop();
  let held = await readTask(input.taskIds[3]);
  assert.equal(held.properties.worker.state, "active");
  const retried = await control(["worker", "retry", held.id, "--project", input.b.id, "--claim-id", held.properties.worker.claimId]);
  assert.equal(retried.code, 0, retried.output);
  held = await readTask(input.taskIds[3]);
  const released = await control(["worker", "release", held.id, "--project", input.b.id, "--claim-id", held.properties.worker.claimId, "--if-version", String(held.version)]);
  assert.equal(released.code, 0, released.output);
  assert.equal((await readTask(held.id)).properties.worker.state, "released");
  const unavailable = await control(["worker", "retry", input.aTaskId, "--project", input.a.id, "--claim-id", input.aClaimId]);
  assert.equal(unavailable.code, 1, unavailable.output);
  const desired = (await selection()).desired;
  assert.ok(desired.value.projects.some(project => project.projectId === input.a.id));
  const removed = await request("PUT", `/api/v1/me/workers/${workerId}/configuration`, { revision: desired.revision, value: { ...desired.value, projects: desired.value.projects.filter(project => project.projectId !== input.a.id) } });
  assert.deepEqual(removed.desired.value.projects.map(project => project.projectId), [input.b.id]);
  const observed = await events();
  assert.deepEqual(observed.filter(event => event.kind === "fixture-error"), []);
  assert.deepEqual(observed.filter(event => event.kind === "agent-completed").map(event => event.taskId), input.taskIds.slice(0, 3));
  process.stdout.write("real-service-installed-worker-ok\n");
} finally {
  if (running && running.exitCode === null) { running.kill("SIGKILL"); await new Promise(resolve => running.once("exit", resolve)); }
  for (const pid of new Set((await events()).filter(event => ["daemon-start", "workspace", "native-start"].includes(event.kind)).map(event => event.pid).filter(Boolean))) {
    let environment;
    try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); if (stat.slice(stat.lastIndexOf(") ") + 2, stat.lastIndexOf(") ") + 3) === "Z") continue; environment = await readFile(`/proc/${pid}/environ`, "utf8"); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
    if (!environment.split("\0").includes(`FIXTURE_EVENTS=${eventsFile}`)) throw new Error(`Fixture process identity changed: ${pid}`);
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    const deadline = Date.now() + 2000;
    while (true) {
      try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); if (stat.slice(stat.lastIndexOf(") ") + 2, stat.lastIndexOf(") ") + 3) === "Z") break; }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") break; throw error; }
      if (Date.now() >= deadline) throw new Error(`Fixture process did not stop: ${pid}`);
      await sleep(10);
    }
  }
  await new Promise((resolve, reject) => { proxy.close(error => error ? reject(error) : resolve()); proxy.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
}
