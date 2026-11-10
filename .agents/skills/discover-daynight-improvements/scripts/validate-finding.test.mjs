import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArguments, validateFinding } from "./validate-finding.mjs";

const script = fileURLToPath(new URL("./validate-finding.mjs", import.meta.url));
const scratch = fileURLToPath(new URL("../../../../.tmp/finding-tests/", import.meta.url));

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "finding 中文 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, content) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content));
  };
  const manifest = { format: "daynight-finding-v1", title: "窄屏标题被操作区挤压", description: "task.md", prototype: "prototype.html", evidence: ["evidence/before/evidence.json"], supportingFiles: [] };
  const capture = { format: "daynight-ui-evidence-v1", status: "consistent", mode: "screenshot", artifact: { kind: "screenshot", path: "screen.png", compositorScreenshot: true } };
  const bytes = Buffer.from([0, 255, 129, 10, 42]);
  await put("task.md", "# 一个独立问题\n\n[原型](prototype.html)\n![证据](evidence/before/screen.png)\n[规范](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)\n");
  await put("prototype.html", "<!doctype html><button type=button>展开</button>");
  await put("evidence/before/evidence.json", capture);
  await put("evidence/before/screen.png", bytes);
  const save = () => put("finding.json", manifest);
  await save();
  return { root, put, manifest, capture, bytes, save, file: path.join(root, "finding.json") };
}

test("builds an exact byte inventory, including capture artifacts, without writing the package", async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.root, { recursive: true });
  const result = await validateFinding(f.file);
  assert.equal(result.valid, true);
  assert.equal(result.title, f.manifest.title);
  assert.deepEqual(result.files.map((file) => file.path), ["evidence/before/evidence.json", "evidence/before/screen.png", "finding.json", "prototype.html", "task.md"]);
  const image = result.files.find((file) => file.path.endsWith("screen.png"));
  assert.equal(image.bytes, f.bytes.length);
  assert.equal(image.sha256, createHash("sha256").update(f.bytes).digest("hex"));
  assert.deepEqual(await readdir(f.root, { recursive: true }), before);
  await f.put("prototype.html", "changed prototype");
  const changed = await validateFinding(f.file);
  assert.notEqual(changed.files.find((file) => file.path === "prototype.html").sha256, result.files.find((file) => file.path === "prototype.html").sha256);
});

test("requires one package with a title, description and evidence", async (t) => {
  const f = await fixture(t);
  for (const field of ["title", "description", "evidence"]) {
    const original = f.manifest[field];
    delete f.manifest[field]; await f.save();
    await assert.rejects(validateFinding(f.file), new RegExp(field));
    f.manifest[field] = original;
  }
  f.manifest.issues = [{ title: "second issue" }]; await f.save();
  await assert.rejects(validateFinding(f.file), /issues/);
  delete f.manifest.issues; f.manifest.evidence = []; await f.save();
  await assert.rejects(validateFinding(f.file), /evidence/);
});

test("rejects path escapes, symlink files and symlink directories", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "..", `${path.basename(f.root)}-private`);
  await writeFile(outside, "private value"); t.after(() => rm(outside, { force: true }));
  for (const target of ["../private", outside, "nested/../../private", "nested\\file", "./task.md"]) {
    f.manifest.supportingFiles = [target]; await f.save();
    await assert.rejects(validateFinding(f.file), /relative|component|path/i);
  }
  await symlink(outside, path.join(f.root, "secret"));
  f.manifest.supportingFiles = ["secret"]; await f.save();
  await assert.rejects(validateFinding(f.file), /symbolic|symlink/i);
  await symlink(path.dirname(outside), path.join(f.root, "linked"));
  f.manifest.supportingFiles = [`linked/${path.basename(outside)}`]; await f.save();
  await assert.rejects(validateFinding(f.file), /symbolic|symlink/i);
  assert.equal(await readFile(outside, "utf8"), "private value");
});

test("rejects missing, non-file, empty and duplicate role files", async (t) => {
  const f = await fixture(t);
  for (const name of ["absent.md", "evidence", "empty.md"]) {
    if (name === "empty.md") await f.put(name, "");
    f.manifest.description = name; await f.save();
    await assert.rejects(validateFinding(f.file));
  }
  f.manifest.description = "task.md"; f.manifest.supportingFiles = ["task.md"]; await f.save();
  await assert.rejects(validateFinding(f.file), /duplicate/i);
});

test("refuses failed or mismatched capture evidence without deleting it", async (t) => {
  const f = await fixture(t);
  for (const status of ["inconsistent", "failed", "complete", undefined]) {
    f.capture.status = status; await f.put("evidence/before/evidence.json", f.capture);
    await assert.rejects(validateFinding(f.file), /consistent/);
  }
  f.capture.status = "consistent"; f.capture.artifact.path = "../other.png";
  await f.put("evidence/before/evidence.json", f.capture);
  await assert.rejects(validateFinding(f.file), /component|path/);
  assert.equal((await readFile(path.join(f.root, "evidence/before/screen.png"))).length, f.bytes.length);
});

test("accepts explicit geometry and manual interaction evidence without claiming visual proof", async (t) => {
  const f = await fixture(t);
  f.capture.mode = "geometry"; f.capture.artifact = null;
  await f.put("evidence/before/evidence.json", f.capture);
  await f.put("task.md", "[原型](prototype.html)\n[交互证据][steps]\n\n[steps]: <evidence/keyboard.md>\n");
  await f.put("evidence/keyboard.md", "Shift+Tab: focus moved to the previous control; menu remained closed.\n");
  f.manifest.evidence.push("evidence/keyboard.md"); await f.save();
  const result = await validateFinding(f.file);
  assert.equal(result.valid, true);
  assert.ok(!result.files.some((file) => file.path.endsWith("screen.png")));
  assert.ok(result.files.some((file) => file.path === "evidence/keyboard.md"));
});

test("checks declared attachment links including escaped names and refuses unlisted local files", async (t) => {
  const f = await fixture(t);
  await f.put("evidence/测量 (loaded).md", "manual measurement\n");
  f.manifest.supportingFiles.push("evidence/测量 (loaded).md"); await f.save();
  await f.put("task.md", "[measurement](<evidence/%E6%B5%8B%E9%87%8F%20(loaded).md#state>)\n[section](#local)\n");
  assert.equal((await validateFinding(f.file)).valid, true);
  for (const href of ["unlisted.md", "../outside.md", "file:///tmp/private", "/tmp/private"]) {
    await f.put("task.md", `[attachment](${href})\n`);
    await assert.rejects(validateFinding(f.file), /link|relative|path|component/i);
  }
});

test("CLI emits an inventory only after validation and uses a failing exit code for broken inputs", async (t) => {
  const f = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
  let result = run(f.file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
  result = run("--help"); assert.equal(result.status, 0); assert.match(result.stdout, /finding\.json/);
  await f.put("finding.json", "not json");
  result = run(f.file); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /JSON/);
  result = run(); assert.equal(result.status, 1);
});

test("checks nested labels and quoted titles while ignoring example links in inline code", async (t) => {
  const f = await fixture(t);
  for (const link of ["[Missing](missing.png 'caption')", "[Before [390px]](missing.png)", '[Missing](missing.png "caption")', '[Before](missing.png (caption))']) {
    await f.put("task.md", `${link}\n`);
    await assert.rejects(validateFinding(f.file), /not in the file inventory/);
  }
  await f.put("task.md", "`[literal syntax](missing.png)`\n``[literal `syntax`](missing.png)``\n\n```markdown\n[example](missing.png)\n```\n[Real](prototype.html 'caption')\n");
  assert.equal((await validateFinding(f.file)).valid, true);
  await f.put("task.md", "[Valid [nested]](prototype.html)\n");
  assert.equal((await validateFinding(f.file)).valid, true);
});

test("rejects linked images outside the package Markdown subset and treats titles as literal text", async (t) => {
  const f = await fixture(t);
  await f.put("task.md", "[![Preview](missing-thumbnail.png)](prototype.html)\n");
  await assert.rejects(validateFinding(f.file), /Nested images/);
  for (const title of ['"Use [Enter](literal.png)"', "'Use [Enter](literal.png)'", '(Use [Enter]\\(literal.png\\))']) {
    await f.put("task.md", `[Preview](prototype.html ${title})\n`);
    assert.equal((await validateFinding(f.file)).valid, true);
  }
});

test("resolves inline description links from the attachment root even when its source file is nested", async (t) => {
  const f = await fixture(t);
  f.manifest.description = "docs/task.md";
  f.manifest.prototype = "docs/prototype.html";
  await f.put(f.manifest.prototype, "<!doctype html><button>Preview</button>");
  await f.save();
  await f.put(f.manifest.description, "[Prototype](prototype.html)\n");
  await assert.rejects(validateFinding(f.file), /not in the file inventory: prototype.html/);
  await f.put(f.manifest.description, "[Prototype](docs/prototype.html)\n[Evidence](evidence/before/evidence.json)\n");
  assert.equal((await validateFinding(f.file)).valid, true);
});

test("decodes link segments separately and rejects encoded separators and invalid path characters", async (t) => {
  const f = await fixture(t);
  f.manifest.prototype = "docs/prototype.html";
  await f.put(f.manifest.prototype, "<!doctype html><button>Preview</button>");
  await f.save();
  for (const href of ["docs%2Fprototype.html", "docs%2fprototype.html", "docs%5Cprototype.html", "docs/%GGprototype.html", "docs/%01prototype.html", "docs/%7Fprototype.html", "docs/%2e%2e/prototype.html"]) {
    await f.put("task.md", `[Prototype](${href})\n`);
    await assert.rejects(validateFinding(f.file), /Invalid attachment link/);
  }
  await f.put("docs/测量 100%.md", "measurement\n");
  f.manifest.supportingFiles.push("docs/测量 100%.md"); await f.save();
  await f.put("task.md", "[Prototype](docs/prototype.html)\n[Measurement](docs/%E6%B5%8B%E9%87%8F%20100%25.md#state)\n");
  assert.equal((await validateFinding(f.file)).valid, true);
  for (const name of ["docs/control\u0001.md", "docs/control\u007f.md", "docs/\ud800.md"]) {
    f.manifest.supportingFiles = [name]; await f.save();
    await assert.rejects(validateFinding(f.file), /relative path/);
  }
});

test("makes the prototype optional for the topic-neutral format and required for the UI format", async (t) => {
  const f = await fixture(t);
  delete f.manifest.prototype; await f.save();
  await f.put("task.md", "# 一个独立问题\n\n![证据](evidence/before/screen.png)\n");
  const result = await validateFinding(f.file);
  assert.equal(result.format, "daynight-finding-v1");
  assert.ok(!result.files.some((file) => file.path === "prototype.html"));
  f.manifest.format = "daynight-ui-finding-v1"; await f.save();
  await assert.rejects(validateFinding(f.file), /prototype is required/);
  f.manifest.prototype = ""; f.manifest.format = "daynight-finding-v1"; await f.save();
  await assert.rejects(validateFinding(f.file), /prototype is required/);
  f.manifest.format = "daynight-other-v1"; f.manifest.prototype = "prototype.html"; await f.save();
  await assert.rejects(validateFinding(f.file), /Unsupported finding format/);
});

test("fails on forbidden text in any text file and lists binary files it could not scan", async (t) => {
  const f = await fixture(t);
  const clean = await validateFinding(f.file, { forbid: ["/Users/alice", "alice-private-notes"] });
  assert.deepEqual(clean.privacyScan, { values: 2, unscanned: ["evidence/before/screen.png"] });
  assert.equal((await validateFinding(f.file)).privacyScan, null);
  await f.put("evidence/before/evidence.json", { ...f.capture, observations: [{ text: "cat /USERS/ALICE/.codex/skills/x" }] });
  await assert.rejects(validateFinding(f.file, { forbid: ["/Users/alice"] }), /Forbidden text found:\nevidence\/before\/evidence\.json: \/Users\/alice/);
  await f.put("evidence/before/evidence.json", f.capture);
  await f.put("task.md", "# 一个独立问题\n\n[原型](prototype.html)\n![证据](evidence/before/screen.png)\n见 alice-private-notes。\n");
  await assert.rejects(validateFinding(f.file, { forbid: ["alice-private-notes"] }), /task\.md: alice-private-notes/);
  await assert.rejects(validateFinding(f.file, { forbid: ["  "] }), /nonempty/);
});

test("CLI accepts repeated --forbid values and rejects a missing value", async (t) => {
  const f = await fixture(t);
  const ok = spawnSync(process.execPath, [script, "--forbid", "/Users/alice", "--forbid", "alice", f.file], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).privacyScan.values, 2);
  const missing = spawnSync(process.execPath, [script, f.file, "--forbid"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--forbid needs a nonempty value/);
  assert.deepEqual(parseArguments(["--forbid", "x", "pkg/finding.json"]), { manifest: "pkg/finding.json", forbid: ["x"] });
});
