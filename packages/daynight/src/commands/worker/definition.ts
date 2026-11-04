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
    name: "setup",
    description: "Check prerequisites and prepare the initial local runtime configuration",
    options: [help],
    details: "Use an interactive terminal to check the environment, choose Copilot, Codex or Claude, and select accessible Projects before the Worker first connects.\nReview the selection before saving agent and repository settings together.\nMissing prerequisites remain visible with repair instructions; setup can save configuration before they are repaired.\nExisting transports, paths and compatible native settings are retained.\nAfter enrollment, edit runtime settings in My Workers. Paths and agentControlMode remain local.",
  }, {
    name: "run",
    description: "Run the foreground task worker until interrupted",
    options: [help],
    details: "Read local identity, service settings, paths and agentControlMode from DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml).\nFetch cloud configuration before scheduling. The first connection imports local runtime settings; later starts always use the cloud target.\nAn empty Project selection keeps heartbeats and configuration synchronization running.\nState: DN_CONFIG_DIR/worker/ (default: ~/.daynight/worker/).\nCtrl+C stops the original agents while preserving unfinished claims, worktrees and native history.",
  }, {
    name: "attach",
    description: "Attach an interactive terminal to an existing task runtime",
    options: [help],
    details: "Connect to an existing private Herdr runtime without starting a daemon. On macOS, select a task when multiple recorded runtimes exist; the original daemon identity must be verified. Paused tasks remain available for human input. Installations without a lifecycle journal use the existing shared worker session. Requires an interactive terminal. Detaching leaves the worker and its agents running.",
  }, {
    name: "repo",
    description: "Prepare local repository selections before cloud management",
    commands: [{
      name: "list",
      description: "List local repositories before cloud enrollment",
      options: [{ names: ["--json"], description: "Print local repository summaries as JSON" }, help],
    }, {
      name: "add",
      description: "Select existing remote Projects for the first cloud import",
      options: [{ names: ["--project"], description: "Add this existing accessible Project without prompting", value: { name: "project-id", kind: "text" } }, help],
      details: "Without --project, select one or more accessible remote Projects interactively.\nRepository paths use worker.repositoryRoot (default: ~/daynights).\nThe selection is imported on the first cloud connection; this command does not clone or start tasks.\nAfter enrollment, edit Project selection in My Workers.",
    }, {
      name: "remove",
      description: "Remove configured repositories using existing remote Projects",
      options: [{ names: ["--project"], description: "Remove this existing accessible Project without prompting", value: { name: "project-id", kind: "text" } }, help],
      details: "Without --project, select one or more configured, accessible remote Projects interactively.\nThe local selection is imported on the first cloud connection. Existing claims, files and running tasks are retained.\nAfter enrollment, edit Project selection in My Workers.",
    }],
    options: [help],
  }, {
    name: "retry",
    description: "Attempt recovery once for an active original claim",
    arguments: task,
    options: [claim, project, help],
    details: "Stop worker run first. Attempt one reconnection or recovery for the active claim under the same exclusive lock. Keep its recorded agent and native session ID, using current applicable settings. A NULL session ID logs an informational message and starts a fresh conversation. Pending claims use normal run scheduling.",
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
    details: "Stop worker run first. --claim-id identifies the previous released claim. The original owner or a project admin may explicitly resume a ready task, including the manual permission/platform exception. Use a fresh claim, worktree identity and native conversation with this worker's current effective configuration. The source worktree and native history are not required. The exact --if-version is never replaced; uncertain writes are reconciled without replay.",
  }],
  options: [help],
  details: "Run daynight worker <command> --help for command usage.\nState: DN_CONFIG_DIR/worker/ (default: ~/.daynight/worker/).",
};
