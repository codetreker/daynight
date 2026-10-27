import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const claim: CommandOption = { names: ["--claim-id"], description: "Identify the original execution claim", value: { name: "claim-id", kind: "text" }, required: true };
const project: CommandOption = { names: ["--project"], description: "Identify the task's project explicitly", value: { name: "project-id", kind: "text" } };
const version: CommandOption = { names: ["--if-version"], description: "Use exactly this observed task version", value: { name: "version", kind: "text" }, required: true };
const task = [{ name: "task-id", description: "Task UUID" }];
const controlDetails = "Stop worker run first. The command takes the same exclusive instance lock and manages one original claim synchronously. Stop its agent and close its workspace, submit the version-bound remote operation, then delete its worktree after ownership ends. Cleanup waits at most 10 minutes per attempt. An unknown remote result is read back without replaying the write; reconcile an interrupted result before restarting the runner.";

export const workerDefinition: CommandDefinition = {
  name: "worker",
  description: "Run automatically claimed tasks in dedicated worktrees and Herdr",
  commands: [{
    name: "run",
    description: "Run the foreground task worker until interrupted",
    options: [help],
    details: "Read worker settings from ~/.daynight/config.yml at startup.\nWith no configured repositories, select existing remote Projects interactively before startup.\nFor noninteractive configuration, run daynight worker repo add --project <project-id>.\nState: ~/.daynight/worker/ (fixed to the current user's home directory).\nCtrl+C stops the original agents while preserving unfinished claims, worktrees and native history.",
  }, {
    name: "attach",
    description: "Attach an interactive terminal to the running worker's Herdr session",
    options: [help],
    details: "Connect to the existing private worker Herdr session. Start it with daynight worker run first. Requires an interactive terminal. Detaching leaves the worker and its agents running.",
  }, {
    name: "repo",
    description: "Manage repositories selected from existing Daynight Projects",
    commands: [{
      name: "list",
      description: "List configured worker repositories",
      options: [{ names: ["--json"], description: "Print configured repository summaries as JSON" }, help],
    }, {
      name: "add",
      description: "Select existing remote Projects for the next worker startup",
      options: [{ names: ["--project"], description: "Add this existing accessible Project without prompting", value: { name: "project-id", kind: "text" } }, help],
      details: "Without --project, select one or more accessible remote Projects interactively.\nRepository paths use worker.repositoryRoot (default: ~/daynights).\nChanges apply at the next worker startup; this command does not clone or start tasks.",
    }, {
      name: "remove",
      description: "Remove configured repositories using existing remote Projects",
      options: [{ names: ["--project"], description: "Remove this existing accessible Project without prompting", value: { name: "project-id", kind: "text" } }, help],
      details: "Without --project, select one or more configured, accessible remote Projects interactively.\nChanges apply at the next worker startup. Existing claims, files and running tasks are retained.",
    }],
    options: [help],
  }, {
    name: "retry",
    description: "Attempt recovery once for an active original claim",
    arguments: task,
    options: [claim, project, help],
    details: "Stop worker run first. Attempt one reconnection or recovery for the active claim under the same exclusive lock. Keep its recorded agent and native session ID, using current applicable settings. A missing session ID logs a warning and starts a fresh conversation. Pending claims use normal run scheduling.",
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
      { names: ["--target-agent"], description: "Agent type for the target's new execution", value: { name: "agent", kind: "text", choices: ["codex", "copilot"] }, required: true },
      project, help],
    details: `${controlDetails}\nThe target must remain a project member and satisfy automatic permission, platform and dependency requirements. Fresh claim and worktree identities are printed before submission. The target starts normally after receiving the grant; no source files or native history are transported.`,
  }, {
    name: "resume",
    description: "Start a released task as a fresh execution on this worker",
    arguments: task,
    options: [claim, version, project, help],
    details: "Stop worker run first. --claim-id identifies the previous released claim. The original owner or a project admin may explicitly resume a ready task, including the manual permission/platform exception. Use a fresh claim, worktree identity and native conversation with this worker's current effective configuration. The source worktree and native history are not required. The exact --if-version is never replaced; uncertain writes are reconciled without replay.",
  }],
  options: [help],
  details: "Run daynight worker <command> --help for command usage.\nState: ~/.daynight/worker/ (fixed to the current user's home directory).",
};
