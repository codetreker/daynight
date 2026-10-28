import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const claim: CommandOption = { names: ["--claim-id"], description: "Identify the original execution claim", value: { name: "claim-id", kind: "text" }, required: true };
const project: CommandOption = { names: ["--project"], description: "Identify the task's project explicitly", value: { name: "project-id", kind: "text" } };
const version: CommandOption = { names: ["--if-version"], description: "Use exactly this observed task version", value: { name: "version", kind: "text" }, required: true };
const task = [{ name: "task-id", description: "Task UUID" }];
const controlDetails = "The original claim must have a matching local record. Persist the source management decision, then let the sole worker controller clean its agent, workspace and worktree before the version-bound remote operation. Cleanup keeps its original deadline of at most 10 minutes. An unknown remote result is reconciled without replaying the write. A definite refusal requires a new explicit decision with a freshly observed version.";

export const workerDefinition: CommandDefinition = {
  name: "worker",
  description: "Run automatically claimed tasks in dedicated worktrees and Herdr",
  commands: [{
    name: "run",
    description: "Run the foreground task worker until interrupted",
    options: [help],
    details: "Read worker settings from ~/.daynight/config.yml at startup.\nState: ~/.daynight/worker/ (fixed to the current user's home directory).\nCtrl+C stops the original agents while preserving unfinished claims, worktrees and native history.",
  }, {
    name: "retry",
    description: "Authorize one more recovery attempt for a paused original claim",
    arguments: task,
    options: [claim, project, help],
    details: "Retain the original execution identity, frozen configuration and recovery count. Repeated requests do not accumulate extra attempts. The foreground worker remains the sole agent controller; without it, the command acquires the same instance lock.",
  }, {
    name: "release",
    description: "Clean the original execution and release its claim to todo",
    arguments: task,
    options: [claim, version, project, help],
    details: `${controlDetails}\nThe daemon skips released tasks until explicitly resumed.`,
  }, {
    name: "transfer",
    description: "Clean the source and assign a fresh execution to a project member",
    arguments: task,
    options: [claim, version,
      { names: ["--target-user-id"], description: "Target project member UUID", value: { name: "user-id", kind: "text" }, required: true },
      { names: ["--target-worker-id"], description: "Target worker UUID", value: { name: "worker-id", kind: "text" }, required: true },
      { names: ["--target-machine-id"], description: "Target machine UUID", value: { name: "machine-id", kind: "text" }, required: true },
      { names: ["--target-machine-name"], description: "Target machine's reported name", value: { name: "machine-name", kind: "text" }, required: true },
      { names: ["--target-platform"], description: "Target worker's actual platform", value: { name: "platform", kind: "text", choices: ["windows", "linux", "macos"] }, required: true },
      { names: ["--target-agent-control-mode"], description: "Frozen control mode for the new target execution (default: herdr)", value: { name: "mode", kind: "text", choices: ["herdr", "web"] } },
      { names: ["--target-agent"], description: "Agent type for the target's new execution", value: { name: "agent", kind: "text", choices: ["codex", "copilot", "claude"] }, required: true },
      project, help],
    details: `${controlDetails}\nThe target must remain a project member and satisfy automatic permission, platform and dependency requirements. A fresh claim and worktree identity are saved before submission. The target starts normally after receiving the grant; no source files or native history are transported.`,
  }, {
    name: "resume",
    description: "Start a released task as a fresh execution on this worker",
    arguments: task,
    options: [claim, version, project, help],
    details: "--claim-id identifies the previous released claim. The original owner or a project admin may explicitly resume a ready task, including the manual permission/platform exception. Use a fresh claim, worktree identity and native conversation with this worker's current effective configuration. The source worktree and native history are not required. The exact --if-version is never replaced; uncertain writes are reconciled without replay.",
  }],
  options: [help],
  details: "Run daynight worker <command> --help for command usage.\nState: ~/.daynight/worker/ (fixed to the current user's home directory).",
};
