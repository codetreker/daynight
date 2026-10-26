import type { WorkerAgent } from "../../../api/types.js";
import { canonicalId } from "../../../api/parse.js";

export type HerdrAgentConfiguration = { agent: WorkerAgent; model: string | null; args: readonly string[] };

const optionSets = {
  codex: {
    values: new Set(["-c", "--config", "--enable", "--disable", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "--add-dir", "--local-provider"]),
    switches: new Set(["--strict-config", "--oss", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--search", "--no-alt-screen"]),
    inline: new Set<string>(),
  },
  copilot: {
    values: new Set(["--reasoning-effort", "--context", "--auto-tier", "--agent", "--log-dir", "--log-level", "--add-dir", "--disable-mcp-server", "--enable-mcp-server", "--add-github-mcp-toolset", "--add-github-mcp-tool", "--plugin-dir", "--additional-mcp-config", "--mcp-github-auth", "--max-ai-credits"]),
    switches: new Set(["--disable-client-telemetry", "--allow-all-tools", "--allow-all-paths", "--disallow-temp-dir", "--banner", "--screen-reader", "--plain-diff", "--disable-builtin-mcps", "--enable-all-github-mcp-tools", "--allow-all-mcp-server-instructions", "--allow-all-urls", "--allow-all", "--yolo", "--experimental", "--assisted-approval", "--no-custom-instructions", "--no-auto-update", "--no-ask-user", "--no-color", "--no-experimental", "--no-bash-env", "--no-mouse", "--no-eager-powershell-resolution"]),
    inline: new Set(["--allow-tool", "--deny-tool", "--available-tools", "--excluded-tools", "--secret-env-vars", "--allow-url", "--deny-url", "--bash-env", "--mouse", "--sync-session"]),
  },
} as const;

export const validateHerdrAgentArguments = (agent: WorkerAgent, args: readonly string[]): void => {
  if (agent !== "codex" && agent !== "copilot") throw new TypeError("The native agent must be codex or copilot.");
  if (!Array.isArray(args)) throw new TypeError("Native agent arguments must be an array.");
  const options = optionSets[agent];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== "string" || argument === "" || /\p{Cc}/u.test(argument)) throw new TypeError("Native arguments must be nonempty strings without control characters.");
    const equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (options.switches.has(option)) {
      if (equals >= 0) throw new TypeError(`Native switch ${option} does not accept a value.`);
      continue;
    }
    if (options.inline.has(option)) {
      if (equals < 0 || argument.slice(equals + 1) === "") throw new TypeError(`Native option ${option} must use an explicit =value argument.`);
      continue;
    }
    if (!options.values.has(option)) throw new TypeError(`Native argument ${option} is unsupported or owned by the worker; prompts, modes, model, cwd and session selection are supplied separately.`);
    const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
    if (typeof value !== "string" || value === "" || /\p{Cc}/u.test(value) || (equals < 0 && value.startsWith("-"))) throw new TypeError(`Native option ${option} requires one nonempty value without control characters or another option.`);
  }
};

export const buildHerdrAgentArguments = (configuration: HerdrAgentConfiguration, resumeSessionId?: string): string[] => {
  validateHerdrAgentArguments(configuration.agent, configuration.args);
  if (configuration.model !== null && (typeof configuration.model !== "string" || configuration.model === "" || /\p{Cc}/u.test(configuration.model))) throw new TypeError("The native model must be null or nonempty text without control characters.");
  let sessionId: string | undefined;
  if (resumeSessionId !== undefined) {
    sessionId = canonicalId(resumeSessionId) ?? undefined;
    if (sessionId === undefined) throw new TypeError("Native recovery requires the exact original session UUID.");
  }
  const args = configuration.agent === "codex" ? ["--no-daemon", ...(sessionId === undefined ? [] : ["resume", sessionId])] : (sessionId === undefined ? [] : [`--resume=${sessionId}`]);
  if (configuration.model !== null) args.push("--model", configuration.model);
  return [...args, ...configuration.args];
};
