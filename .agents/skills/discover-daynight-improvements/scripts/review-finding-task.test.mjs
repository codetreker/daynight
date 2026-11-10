import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArguments, reviewFindingTask } from "./review-finding-task.mjs";

const script = fileURLToPath(new URL("./review-finding-task.mjs", import.meta.url));
const scratch = fileURLToPath(new URL("../../../../.tmp/finding-tests/", import.meta.url));
const project = "fb1a3e30-f945-4c48-ab0f-55be117e098e";
const task = "0baed1b3-f89d-4559-96cf-ff032ba5f06c";
const user = "45f0043b-4435-4934-9808-7098a36b6c37";

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "review "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "task.md": "# 底部操作区换行\n\n[原型](prototype.html)\n![证据](evidence/idle/screen.png)\n",
    "prototype.html": "<!doctype html><button type=button>Send</button>",
    "evidence/idle/evidence.json": JSON.stringify({ format: "daynight-ui-evidence-v1", status: "consistent", mode: "screenshot", artifact: { kind: "screenshot", path: "screen.png", compositorScreenshot: true } }),
    "evidence/idle/screen.png": Buffer.from([137, 80, 78, 71, 0, 1, 2]),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const manifest = { format: "daynight-finding-v1", title: "底部操作区换行", description: "task.md", prototype: "prototype.html", evidence: ["evidence/idle/evidence.json"] };
  await writeFile(path.join(root, "finding.json"), JSON.stringify(manifest));
  const remote = {
    task: { id: task, title: manifest.title, description: files["task.md"], version: 3, status: "todo", allowAgents: false, assignedTo: user, requiredPlatform: null, dependsOn: [], externalDependsOn: [], blockedBy: [] },
    attachments: new Map(Object.entries(files).filter(([name]) => name !== "task.md").map(([name, content]) => [name, Buffer.from(content)])),
  };
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "task" && args[1] === "show") return { code: 0, stdout: Buffer.from(JSON.stringify(remote.task)), stderr: "" };
    if (args[1] === "attachment" && args[2] === "list") return { code: 0, stdout: Buffer.from(JSON.stringify([...remote.attachments.keys()].map((item) => ({ path: item })))), stderr: "" };
    if (args[1] === "attachment" && args[2] === "read") {
      const bytes = remote.attachments.get(args[4]);
      return bytes ? { code: 0, stdout: bytes, stderr: "" } : { code: 1, stdout: Buffer.alloc(0), stderr: "not found" };
    }
    return { code: 99, stdout: Buffer.alloc(0), stderr: "unexpected command" };
  };
  return { root, file: path.join(root, "finding.json"), remote, calls, run };
}

test("matches a registered task with its package using only read commands", async (t) => {
  const f = await fixture(t);
  const report = await reviewFindingTask(f.file, { run: f.run, project, task, expectAssignee: user });
  assert.equal(report.ok, true);
  assert.equal(report.title, "match");
  assert.equal(report.description, "match");
  assert.equal(report.assignee, "match");
  assert.deepEqual(report.attachments.map((item) => [item.path, item.status]), [
    ["evidence/idle/evidence.json", "match"], ["evidence/idle/screen.png", "match"], ["prototype.html", "match"],
  ]);
  assert.deepEqual(report.unresolvedLinks, []);
  for (const args of f.calls) assert.ok(["show", "attachment"].includes(args[1]) && (args[1] === "show" || ["list", "read"].includes(args[2])), args.join(" "));
  assert.ok(f.calls.every((args) => args.includes("--project") && args.includes(project)));
});

test("reports differing bytes, missing attachments, descriptions and assignees", async (t) => {
  const f = await fixture(t);
  f.remote.attachments.set("prototype.html", Buffer.from("<!doctype html><button>Changed</button>"));
  f.remote.attachments.delete("evidence/idle/screen.png");
  f.remote.task.description = `${f.remote.task.description}\n`;
  f.remote.task.assignedTo = "11111111-2222-4333-8444-555555555555";
  const report = await reviewFindingTask(f.file, { run: f.run, project, task, expectAssignee: user });
  assert.equal(report.ok, false);
  assert.equal(report.description, "differs-trailing-whitespace");
  assert.equal(report.assignee, "differs");
  assert.equal(report.attachments.find((item) => item.path === "prototype.html").status, "differs");
  assert.equal(report.attachments.find((item) => item.path === "evidence/idle/screen.png").status, "missing");
  assert.deepEqual(report.unresolvedLinks, ["evidence/idle/screen.png"]);
});

test("lists attachments added after registration without failing the review", async (t) => {
  const f = await fixture(t);
  f.remote.attachments.set("acceptance/result.md", Buffer.from("# 验收\n"));
  const report = await reviewFindingTask(f.file, { run: f.run, project, task });
  assert.equal(report.ok, true);
  assert.equal(report.assignee, "not-checked");
  assert.deepEqual(report.remoteOnly, ["acceptance/result.md"]);
});

test("stops on a failed read and validates identifiers before running anything", async (t) => {
  const f = await fixture(t);
  const failing = async (args) => (args[1] === "show" ? { code: 1, stdout: Buffer.alloc(0), stderr: "forbidden" } : f.run(args));
  await assert.rejects(reviewFindingTask(f.file, { run: failing, project, task }), /task show failed: forbidden/);
  const calls = [];
  const recording = async (args) => { calls.push(args); return f.run(args); };
  await assert.rejects(reviewFindingTask(f.file, { run: recording, project: "not-a-uuid", task }), /--project/);
  await assert.rejects(reviewFindingTask(f.file, { run: recording, project, task, expectAssignee: "someone" }), /--expect-assignee/);
  assert.equal(calls.length, 0);
});

test("parses explicit options and refuses incomplete command lines", () => {
  const options = parseArguments(["--cli", "/usr/local/bin/daynight", "--config-dir", "/home/u/.daynight", "--project", project, "--task", task, "pkg/finding.json"]);
  assert.equal(options.manifest, "pkg/finding.json");
  assert.equal(options.configDir, "/home/u/.daynight");
  assert.throws(() => parseArguments(["--cli", "/usr/local/bin/daynight", "--project", project, "--task", task, "pkg/finding.json"]), /Usage/);
  assert.throws(() => parseArguments(["--cli", "--project", project]), /Usage/);
  assert.deepEqual(parseArguments(["--help"]), { help: true });
});

test("CLI requires absolute executable and configuration paths before reading anything", async (t) => {
  const f = await fixture(t);
  const result = spawnSync(process.execPath, [script, "--cli", "daynight", "--config-dir", "/tmp/root", "--project", project, "--task", task, f.file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--cli must be an absolute executable path/);
  assert.equal(result.stdout, "");
});
