import type { CommandDefinition, CommandOption } from "../../cli/schema.js";

const help: CommandOption = { names: ["-h", "--help"], description: "Show this help", action: "help" };
const claim: CommandOption = { names: ["--claim-id"], description: "Identify the original execution claim", value: { name: "claim-id", kind: "text" }, required: true };
const project: CommandOption = { names: ["--project"], description: "Identify the task's project explicitly", value: { name: "project-id", kind: "text" } };
const version: CommandOption = { names: ["--if-version"], description: "Use exactly this observed task version", value: { name: "version", kind: "text" }, required: true };
const task = [{ name: "task-id", description: "Task UUID" }];
const controlDetails = "Stop worker run first. The command takes the same exclusive instance lock and manages one original claim synchronously. Stop its agent and close its workspace, submit the version-bound remote operation, then delete its worktree after ownership ends. Cleanup waits at most 10 minutes per attempt. An unknown remote result is not replayed; reconcile an interrupted result before restarting the runner.";

export const workerDefinition: CommandDefinition = {
  name: "worker",
  description: "Run automatically claimed tasks in dedicated worktrees",
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
    description: "Check prerequisites and prepare the initial local runtime configuration",
    options: [help],
    details: "Use an interactive terminal to check the environment, choose Copilot, Codex or Claude, and select accessible Projects before the Worker first connects.\nReview the selection before saving agent and repository settings together.\nMissing prerequisites remain visible with repair instructions; setup can save configuration before they are repaired.\nExisting transports, paths and compatible native settings are retained.\nAfter enrollment, edit runtime settings in My Workers. Paths and agentControlMode remain local.",
  }, {
    name: "run",
    description: "Run the foreground task worker until interrupted",
    options: [help],
    details: "Read local identity, service settings, paths and agentControlMode from DN_CONFIG_DIR/config.yml (default: ~/.daynight/config.yml).\nFetch cloud configuration before scheduling. The first connection imports local runtime settings; later starts always use the cloud target.\nAn empty Project selection keeps heartbeats and configuration synchronization running.\nState: DN_CONFIG_DIR/worker/ (default: ~/.daynight/worker/).\nCtrl+C stops the original agents while preserving unfinished claims, worktrees and native history.",
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
    name: "resources",
    description: "Recover a completed Web execution's retained worktree",
    options: [help],
    details: "Stop worker run first. Recovery uses the original worker lock and never starts an Agent.",
    commands: [{
      name: "recover", description: "Verify or recover a completed Web execution's retained worktree", arguments: task,
      options: [claim, { ...project, required: true }, { names: ["--worktree-id"], description: "Verify this exact original worktree UUID; omission reads the original journal", value: { name: "worktree-id", kind: "text" } }, { names: ["--confirm"], description: "Remove the verified clean original worktree and retire its manifest" }, help],
      details: "Stop worker run first. Without --confirm, verify original service, owner, Worker, terminal claim, Web journal, native stop, ready archive and preserved Git content without deletion. With --confirm, repeat verification and remove only the matching clean worktree without force; keep its branch and journals. Missing original evidence, successor claims, dirty/untracked/ignored files and commits without an observed remote reference refuse recovery. Restore original evidence from backup; a Git marker or done Task alone is insufficient.",
    }],
  }, {
    name: "repair-markdown",
    description: "Repair failed Markdown images in one stopped original Web execution and archive it",
    arguments: task,
    options: [claim, { ...project, required: true }, { names: ["--session-id"], description: "Original Session UUID", value: { name: "session-id", kind: "text" }, required: true }, { names: ["--worktree-id"], description: "Original worktree UUID", value: { name: "worktree-id", kind: "text" }, required: true }, help],
    details: "Select the original completed claim, Session and retained worktree. The command verifies the stopped Controller and takes its storage lock; the Worker may remain running. It reanalyses saved complete Markdown inputs and authorizes local image reads only inside the original verified worktree. Missing, changed or forbidden sources retain the original failure and report the next action. It never starts an Agent, replays user input or changes Task status. Successful repair follows the existing archive protocol; the Worker owns later cleanup.",
  }, {
    name: "reboot-recovery",
    description: "Prepare or verify reboot evidence for an original Windows Web execution",
    arguments: task,
    options: [claim, { ...project, required: true }, { names: ["--session-id"], description: "Original Session UUID", value: { name: "session-id", kind: "text" }, required: true }, { names: ["--worktree-id"], description: "Original worktree UUID", value: { name: "worktree-id", kind: "text" }, required: true }, { names: ["--prepare"], description: "Checkpoint the original execution before a full Windows restart" }, help],
    details: "Use --prepare before restarting Windows to bind the original ticket and journal to this Windows installation and kernel boot. After a full restart, run the same command without --prepare to confirm the old process tree stopped. The Worker may remain running; a live Controller's storage lock blocks recovery. Same-boot restarts, signing out, missing checkpoints, changed executions and unknown boot identity never prove stop. This command never restarts Windows, starts an Agent, replays input, releases a claim or deletes a worktree. Original owner authorization and confirmed initial input are required.",
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
    details: `${controlDetails}\nReleased tasks remain eligible for ordinary automatic acquisition.`,

  }],
  options: [help],
  details: "Run daynight worker <command> --help for command usage.\nState: DN_CONFIG_DIR/worker/ (default: ~/.daynight/worker/).",
};
