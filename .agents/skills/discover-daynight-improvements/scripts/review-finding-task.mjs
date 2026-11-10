#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { descriptionLinks, validateFinding } from "./validate-finding.mjs";

const usage = "Usage: node review-finding-task.mjs --cli <daynight executable> --config-dir <configuration root> --project <project UUID> --task <task UUID> [--expect-assignee <user UUID>] <package/finding.json>\nCompares one registered task with its local finding package using only `task show`, `task attachment list` and `task attachment read`. Prints a JSON report and exits nonzero when anything differs. It does not judge content sufficiency, responsibility or permission to enable automatic execution.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every command this script can issue. Anything else is refused before it runs.
const readCommands = [["task", "show"], ["task", "attachment", "list"], ["task", "attachment", "read"]];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// Runs the selected CLI without a shell, with the explicit configuration root.
export function cliRunner({ cli, configDir, env = process.env }) {
  check(typeof cli === "string" && path.isAbsolute(cli), "--cli must be an absolute executable path.");
  check(typeof configDir === "string" && path.isAbsolute(configDir), "--config-dir must be an absolute directory path.");
  return (args) => new Promise((resolve) => {
    execFile(cli, args, { env: { ...env, DN_CONFIG_DIR: configDir }, encoding: "buffer", maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: stdout ?? Buffer.alloc(0), stderr: Buffer.from(stderr ?? "").toString("utf8") });
    });
  });
}

export async function reviewFindingTask(manifestPath, { run, project, task, expectAssignee }) {
  check(typeof run === "function", "A CLI runner is required.");
  check(uuid.test(project ?? ""), "--project must be a project UUID.");
  check(uuid.test(task ?? ""), "--task must be a task UUID.");
  check(expectAssignee === undefined || uuid.test(expectAssignee), "--expect-assignee must be a user UUID.");
  const read = async (args) => {
    const command = readCommands.find((prefix) => prefix.every((part, index) => args[index] === part));
    check(command, `Refusing a command that is not a read: ${args.slice(0, 3).join(" ")}`);
    const result = await run(args);
    check(result.code === 0, `daynight ${command.join(" ")} failed: ${String(result.stderr).trim().slice(0, 300)}`);
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  };

  const inventory = await validateFinding(manifestPath);
  const manifestName = path.basename(manifestPath);
  const manifest = JSON.parse(await readFile(path.join(inventory.directory, manifestName), "utf8"));
  const localDescription = await readFile(path.join(inventory.directory, manifest.description), "utf8");

  const remote = JSON.parse((await read(["task", "show", task, "--project", project, "--json"])).toString("utf8"));
  const listed = JSON.parse((await read(["task", "attachment", "list", task, "--project", project, "--json"])).toString("utf8"));
  check(Array.isArray(listed), "The attachment list is not an array.");
  const remotePaths = new Set(listed.map((item) => item.path));
  const expected = inventory.files.filter((file) => file.path !== manifestName && file.path !== manifest.description);

  const attachments = [];
  for (const file of expected) {
    if (!remotePaths.has(file.path)) { attachments.push({ path: file.path, status: "missing" }); continue; }
    const bytes = await read(["task", "attachment", "read", task, file.path, "--project", project]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    attachments.push({ path: file.path, status: sha256 === file.sha256 && bytes.length === file.bytes ? "match" : "differs", bytes: bytes.length, sha256 });
  }

  const description = typeof remote.description === "string" ? remote.description : "";
  const descriptionStatus = description === localDescription ? "match"
    : description.trimEnd() === localDescription.trimEnd() ? "differs-trailing-whitespace" : "differs";
  const unresolvedLinks = descriptionLinks(description).filter((link) => !remotePaths.has(link));
  const report = {
    task,
    project,
    version: remote.version,
    status: remote.status,
    allowAgents: remote.allowAgents,
    assignedTo: remote.assignedTo ?? null,
    requiredPlatform: remote.requiredPlatform ?? null,
    dependsOn: remote.dependsOn ?? [],
    externalDependsOn: remote.externalDependsOn ?? [],
    blockedBy: remote.blockedBy ?? [],
    title: remote.title === manifest.title ? "match" : "differs",
    description: descriptionStatus,
    assignee: expectAssignee === undefined ? "not-checked" : remote.assignedTo === expectAssignee ? "match" : "differs",
    attachments,
    unresolvedLinks,
    remoteOnly: [...remotePaths].filter((item) => !expected.some((file) => file.path === item)).sort((a, b) => a.localeCompare(b, "en")),
  };
  report.ok = report.title === "match" && report.description === "match" && report.assignee !== "differs"
    && attachments.every((item) => item.status === "match") && unresolvedLinks.length === 0;
  return report;
}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = {};
  const names = new Map([["--cli", "cli"], ["--config-dir", "configDir"], ["--project", "project"], ["--task", "task"], ["--expect-assignee", "expectAssignee"]]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (names.has(value)) {
      const next = args[++index];
      check(next !== undefined && !next.startsWith("--") && options[names.get(value)] === undefined, usage);
      options[names.get(value)] = next;
    } else {
      check(!value.startsWith("-") && options.manifest === undefined, usage);
      options.manifest = value;
    }
  }
  check(["cli", "configDir", "project", "task", "manifest"].every((name) => options[name] !== undefined), usage);
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(usage);
    else {
      const report = await reviewFindingTask(options.manifest, { ...options, run: cliRunner(options) });
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
