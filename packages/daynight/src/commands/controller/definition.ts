import type { CommandDefinition, CommandOption } from "../../cli/schema.js";
const value = (names: string[], description: string, repeatable = false): CommandOption => ({ names, description, value: { name: "value", kind: "text" }, ...(repeatable ? { repeatable: true } : {}) });
export const controllerDefinition: CommandDefinition = {
  name: "controller", description: "Run a foreground Test Session in the current directory",
  commands: ["codex", "claude", "copilot"].map(name => ({ name, description: `Run a ${name} Test Session`, commands: [controllerResumeDefinition(name), controllerArchiveDefinition(name)], options: [
    value(["--model", "-m"], "Select the native model"),
    ...(name === "codex" ? [value(["--sandbox", "-s"], "Native sandbox mode"), value(["--ask-for-approval", "-a"], "Native approval policy")] : []),
    ...(name === "claude" ? [value(["--permission-mode"], "Native permission mode"), value(["--add-dir"], "Additional native working directory", true)] : []),
    value(["--effort"], "Native reasoning effort supported by this adapter"),
    value(["--launch-id"], "Read the private worker launch ticket with this UUID (exclusive)"),
    { names: ["-h", "--help"], description: "Show this help", action: "help" as const },
  ], allowOptionsTerminator: true,
  details: `Usage: daynight controller ${name} [options] [prompt]\n\nUse daynight controller ${name} resume [test-session-id] to continue saved native context. The optional prompt is submitted once. Without it, send the first message from the Test Session page. The current directory is used as-is. The printed Daynight URL requires login; Ctrl+C stops the owned native execution. --launch-id is reserved for private worker launches and cannot be combined with a prompt or provider options. State and credentials remain in the current user's private Daynight directory.` })),
  options: [{ names: ["-h", "--help"], description: "Show this help", action: "help" }],
};

export function controllerResumeDefinition(provider: string): CommandDefinition { return {
  name: 'resume', description: `Continue a stopped local ${provider} Test Session`,
  options: [{ names: ['-h', '--help'], description: 'Show this help', action: 'help' }],
  details: `Usage: daynight controller ${provider} resume [test-session-id]\n\nWithout an ID, choose a saved Test Session in the current directory. Noninteractive use requires an ID. The original native context is continued in a new protected Daynight page; the old page stays archived. Active or unconfirmed executions cannot be resumed. No initial prompt is replayed. To start with the literal prompt resume, use: daynight controller ${provider} -- resume.`,
}; }

export function controllerArchiveDefinition(provider: string): CommandDefinition { return {
  name: "archive", description: "Retry uploading stopped Test Session history without starting an agent",
  arguments: [{ name: "test-session-id", description: "Saved Daynight Test Session UUID" }],
  options: [{ names: ["-h", "--help"], description: "Show this help", action: "help" }],
  details: `Usage: daynight controller ${provider} archive <test-session-id>\n\nReconcile the original stopped execution and upload its read-only history. Uses the configured server and private launch evidence; never starts or resumes an agent. The original working directory need not exist.`,
}; }
