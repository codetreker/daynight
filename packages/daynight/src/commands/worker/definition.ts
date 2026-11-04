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
    name: "list",
    description: "List the signed-in account's recently reported remote Workers",
    options: [{ names: ["--json"], description: "Print all Worker summaries and the service observation time as JSON" }, help],
    details: "Read every page before printing a result. The service lists Workers reported within the last 72 hours.\nOnline means the last report was less than two minutes before the service observation. Unknown or stale task inventory is not idle capacity.\nWorks outside Git without a project, local Worker configuration or runner lock.",
  }, {
    name: "show",
    description: "Show a remote Worker's telemetry and authorized task observations",
    arguments: [{ name: "worker-id", description: "Worker UUID" }],
    options: [{ names: ["--json"], description: "Print the complete Worker detail and service observation time as JSON" }, help],
    details: "Read the explicit Worker from the configured service, including outside Git.\nProbe failures, missing software and stale or unavailable inventory remain visible. Online is an observation, not a promise of capacity or Agent availability.\nThis command does not start, attach to or lock the local Worker.",
  }, {
    name: "setup",
    description: "Check prerequisites and select an agent and existing Daynight Projects",
    options: [help],
    details: "Use an interactive terminal to check the environment, choose Copilot or Codex, and select one or more accessible Projects.\nReview the selection before saving agent and repository settings together.\nMissing prerequisites remain visible with repair instructions; setup can save configuration before they are repaired.\nExisting transports, paths and compatible native settings are retained. The selected agent applies to every selected Project.\nChanges apply at the next worker startup. Run daynight worker run after completing setup.",
  }, {
    name: "run",
    description: "Run the foreground task worker until interrupted",
    options: [help],
    details: "Read worker settings from DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml) at startup.\nAn empty repository list starts without prompting; no Project, task or worktree is created.\nTo enable new task acquisition, run daynight worker repo add --project <project-id> before restarting.\nState: DN_CONFIG_DIR/worker/ (default: ~/.daynight/worker/).\nCtrl+C stops the original agents while preserving unfinished claims, worktrees and native history.",
  }, {
    name: "attach",
    description: "Attach an interactive terminal to an existing task runtime",
    options: [help],
    details: "Connect to an existing private Herdr runtime without starting a daemon. On macOS, select a task when multiple recorded runtimes exist; the original daemon identity must be verified. Paused tasks remain available for human input. Installations without a lifecycle journal use the existing shared worker session. Requires an interactive terminal. Detaching leaves the worker and its agents running.",
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
    name: "resources",
    description: "Inspect and explicitly dispose stopped Herdr recording resources",
    options: [help],
    details: "Stop worker run first. These commands use the original worker lock and never start an Agent. Inspection reports original Session, claim, stop evidence, worktree, source and archive disposition as JSON.",
    commands: [{
      name: "list", description: "Inspect retained original execution resources", options: [help],
    }, {
      name: "retry", description: "Explicitly retry a stopped original archive after fixing its cause", arguments: task,
      options: [claim, { ...project, required: true }, { names: ["--session-id"], description: "Original Session UUID", value: { name: "session-id", kind: "text" }, required: true }, { names: ["--worktree-id"], description: "Original worktree UUID", value: { name: "worktree-id", kind: "text" }, required: true }, help],
      details: "Retain the original owner, source and operation. This schedules archive reconciliation only; it cannot recover an Agent or repair corrupt source.",
    }, {
      name: "dispose", description: "Record an explicit abandonment or delete stopped original resources", arguments: task,
      options: [claim, { ...project, required: true }, { names: ["--session-id"], description: "Original Session UUID", value: { name: "session-id", kind: "text" }, required: true }, { names: ["--worktree-id"], description: "Original worktree UUID", value: { name: "worktree-id", kind: "text" }, required: true }, { names: ["--operation-id"], description: "Stable UUID for this explicit disposal decision", value: { name: "operation-id", kind: "text" }, required: true }, { names: ["--action"], description: "abandon retains files; delete removes the selected worktree and recording source", value: { name: "action", kind: "text" }, required: true }, { names: ["--confirm"], description: "Confirm this exact disposal and its loss of local recording data", required: true }, help],
      details: "Read resources list first. Only the matching terminal claim with confirmed original stop may be disposed. Abandon stops archive retry and keeps files. Delete removes only the original source and worktree through ownership checks. Neither action manufactures ready/unavailable or changes remote archive history. Reuse the same operation ID to reconcile an interrupted decision.",
    }],
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
