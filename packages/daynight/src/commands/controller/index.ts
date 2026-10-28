import { UsageError, type CliContext } from "../../cli/context.js";
import { canonicalId } from "../../api/parse.js";
import { parseCommand, selectCommand, renderCommandHelp } from "../../cli/schema.js";
import { controllerDefinition, controllerResumeDefinition } from "./definition.js";
import { parseProviderArguments } from "./providers/projection.js";
import type { SessionProvider } from "../../session/protocol.js";
export type IndependentControllerInput = { provider: SessionProvider; model: string | null; args: string[]; prompt: string | null; resume?: { sessionId: string | null } };
export const runControllerCommand = async (args: readonly string[], context: CliContext): Promise<void> => {
  const selected = selectCommand(controllerDefinition, args, ["daynight", "controller"], "daynight controller --help");
  if (selected.kind !== "selected") { context.stdout(renderCommandHelp(selected.command, selected.path)); return; }
  if (selected.remaining[0] === "resume") {
    const provider = selected.command.name as SessionProvider, remaining = selected.remaining.slice(1);
    const base = controllerResumeDefinition(provider);
    const parsed = parseCommand({ ...base, ...(remaining.some(arg => !arg.startsWith("-")) ? { arguments: [{ name: "test-session-id", description: "Saved Daynight Test Session UUID" }] } : {}) }, remaining, [...selected.path, "resume"]);
    if (parsed.kind !== "run") { context.stdout(renderCommandHelp(parsed.command, parsed.path)); return; }
    const sessionId = parsed.values[0] ?? null;
    if (sessionId !== null && canonicalId(sessionId) !== sessionId) throw new UsageError("Test Session ID must be a canonical UUID.");
    await (await import("./independent.js")).runIndependentController({ provider, model: null, args: [], prompt: null, resume: { sessionId } }, context);
    return;
  }
  // The shared command schema has required positionals; this command alone has
  // one optional native-style prompt, so declare it only when one is present.
  let positional = false, terminator = false;
  for (let i = 0; i < selected.remaining.length; i++) {
    const arg = selected.remaining[i]!;
    if (!terminator && arg === "--") { terminator = true; continue; }
    if (!terminator && arg.startsWith("-")) { if (!arg.includes("=") && selected.command.options?.find(o => o.names.includes(arg))?.value) i++; continue; }
    positional = true;
  }
  const { commands: _subcommands, ...providerDefinition } = selected.command;
  const definition = { ...providerDefinition, ...(positional ? { arguments: [{ name: "prompt", description: "Optional first native input" }] } : {}) };
  const command = parseCommand(definition, selected.remaining, selected.path, "daynight controller --help");
  if (command.kind !== "run") { context.stdout(renderCommandHelp(command.command, command.path)); return; }
  const provider = command.command.name as SessionProvider, launchId = command.options.get("--launch-id");
  if (launchId !== undefined) {
    if (typeof launchId !== "string" || canonicalId(launchId) !== launchId) throw new UsageError("Controller launch ID must be a canonical UUID.");
    if (command.options.size !== 1 || command.values.length) throw new UsageError("--launch-id cannot be combined with a prompt or provider options.");
    await (await import("./runtime.js")).runController({ homeDirectory: context.homeDirectory(), provider, launchId }); return;
  }
  const nativeArgs: string[] = [];
  for (const [name, value] of command.options) {
    if (name === "--model") continue;
    for (const item of typeof value === "string" ? [value] : Array.isArray(value) ? value : []) nativeArgs.push(name, item);
  }
  parseProviderArguments(provider, nativeArgs);
  const model = command.options.get("--model"), prompt = command.values[0] ?? null;
  if (model !== undefined && (typeof model !== "string" || !model.trim() || /[\0\r\n]/.test(model))) throw new UsageError("Native model is invalid.");
  if (prompt !== null && (!prompt.trim() || !prompt.isWellFormed() || prompt.includes("\0") || Buffer.byteLength(prompt) > 1_048_576)) throw new UsageError("Prompt must be valid nonempty text within 1 MiB.");
  await (await import("./independent.js")).runIndependentController({ provider, model: typeof model === "string" ? model : null, args: nativeArgs, prompt }, context);
};
