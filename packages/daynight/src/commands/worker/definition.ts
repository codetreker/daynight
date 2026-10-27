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
    name: "resume",
    description: "Start a released task as a fresh execution on this worker",
    arguments: task,
    options: [claim, version, project, help],
    details: "--claim-id identifies the previous released claim. The original owner or a project admin may explicitly resume a ready task, including the manual permission/platform exception. Use a fresh claim, worktree identity and native conversation with this worker's current effective configuration. The source worktree and native history are not required. The exact --if-version is never replaced; uncertain writes are reconciled without replay.",
  }],
  options: [help],
  details: "Run daynight worker <command> --help for command usage.\nState: ~/.daynight/worker/ (fixed to the current user's home directory).",
};
