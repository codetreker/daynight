import { canonicalId } from "../../api/validation.js";
import type { PostThreadMessageInput, ThreadReadQuery } from "../../api/types.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { isNonemptyText } from "../../platform/text.js";
import type { TaskCommandDependencies } from "./command.js";
import { ThreadCommandError } from "./thread-diagnostics.js";
import { renderThreadPage, renderThreadPostReceipt } from "./thread-rendering.js";

type Command = Extract<ParsedCommand, { kind: "run" }>;
const parseId = (value: string, label: string, help: string): string => {
  const parsed = canonicalId(value);
  if (parsed === null) throw new UsageError(`${label} must be a hyphenated UUID.`, help);
  return parsed;
};
const optionalId = (command: Command, option: string, help: string): string | undefined => {
  const value = command.options.get(option) as string | undefined;
  return value === undefined ? undefined : parseId(value, option.slice(2), help);
};
export const compileThreadRead = (command: Command): ThreadReadQuery => {
  const help = `${command.path.join(" ")} --help`;
  const beforeId = optionalId(command, "--before-id", help), afterId = optionalId(command, "--after-id", help);
  if (beforeId !== undefined && afterId !== undefined) throw new UsageError("--before-id and --after-id are mutually exclusive.", help);
  const value = command.options.get("--count") as string | undefined;
  if (value !== undefined && (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 100)) throw new UsageError("--count must be a decimal integer from 1 to 100.", help);
  return { count: value === undefined ? 20 : Number(value), details: command.options.has("--details"), ...(beforeId === undefined ? {} : { beforeId }), ...(afterId === undefined ? {} : { afterId }) };
};
export const compileThreadPost = (command: Command): PostThreadMessageInput => {
  const help = `${command.path.join(" ")} --help`;
  const body = command.options.get("--body") as string;
  if (!isNonemptyText(body) || Buffer.byteLength(body, "utf8") > 65536) throw new UsageError("--body must be nonempty text without NUL or invalid Unicode, at most 65536 UTF-8 bytes.", help);
  const replyTo = optionalId(command, "--reply-to", help), claimId = optionalId(command, "--claim-id", help);
  return { body, ...(replyTo === undefined ? {} : { replyTo }), ...(claimId === undefined ? {} : { claimId }) };
};

export const runTaskThreadCommand = async (command: Command, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  const name = command.command.name as "read" | "post";
  let projectId: string | undefined, taskId: string | undefined;
  let phase: "prepare" | "request" | "render" | "output" = "prepare";
  let confirmedMessageId: string | undefined;
  try {
    const help = `${command.path.join(" ")} --help`;
    taskId = parseId(command.values[0]!, "task-id", help);
    projectId = optionalId(command, "--project", help);
    const read = name === "read" ? compileThreadRead(command) : undefined;
    const post = name === "post" ? compileThreadPost(command) : undefined;
    await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
      operation.check();
      if (projectId === undefined) projectId = (await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })).id;
      operation.check();
      phase = "request";
      if (read !== undefined) {
        const page = await api.readTaskThread(projectId, taskId!, read);
        operation.check();
        phase = "render";
        const output = renderThreadPage(page, read.afterId === undefined ? read.beforeId === undefined ? "latest" : "before" : "after", () => operation.check());
        phase = "output";
        await context.stdoutBytes(Buffer.from(output, "utf8"), operation.signal);
        return;
      }
      const message = await api.postTaskThreadMessage(projectId, taskId!, post!);
      confirmedMessageId = message.id;
      return { kind: "confirmed-mutation", output: renderThreadPostReceipt(message), failureText: (phase) => `Message posted. Id: ${message.id}\nThe message is confirmed, but local ${phase} failed.` };
    });
  } catch (cause) {
    if (cause instanceof PublicDiagnosticError) throw cause;
    if (confirmedMessageId !== undefined) throw new PublicDiagnosticError(`Message posted. Id: ${confirmedMessageId}\nThe message is confirmed, but local receipt preparation failed.`, 1, { cause });
    throw new ThreadCommandError(cause, name, phase, projectId, taskId);
  }
};
