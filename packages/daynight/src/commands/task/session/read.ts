import { stringifyApiJson } from "../../../api/json.js";
import { canonicalId } from "../../../api/validation.js";
import { taskObservationPartial } from "../../../api/task-observation.js";
import { UsageError } from "../../../cli/context.js";
import type { CliContext } from "../../../cli/context.js";
import { PublicDiagnosticError } from "../../../platform/diagnostics.js";
import type { TaskCommandDependencies } from "../command.js";
import type { TaskSessionCommand } from "./registry.js";
import { SessionReadCommandError } from "./read-diagnostics.js";
import { renderTaskSessionChunk, renderTaskSessionCurrent, renderTaskSessionDirectory, renderTaskSessionInspection, renderTaskSessionPage } from "./read-rendering.js";

const parseId = (value: string, label: string, help: string): string => {
  const parsed = canonicalId(value);
  if (parsed === null) throw new UsageError(`${label} must be a hyphenated UUID.`, help);
  return parsed;
};
const parseCursor = (value: string | undefined, help: string): string | undefined => {
  if (value !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(value)) throw new UsageError("Cursor must be a nonempty returned token of at most 4096 ASCII bytes.", help);
  return value;
};

export const run = async (command: TaskSessionCommand, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  const name = command.command.name;
  const help = `${command.path.join(" ")} --help`;
  let projectId: string | undefined, taskId: string | undefined, sessionId: string | undefined;
  let phase: "prepare" | "request" | "render" | "output" = "prepare";
  try {
    taskId = parseId(command.values[0]!, "task-id", help);
    if (command.values[1] !== undefined) sessionId = parseId(command.values[1], "session-id", help);
    const rawProject = command.options.get("--project") as string | undefined;
    if (rawProject !== undefined) projectId = parseId(rawProject, "--project", help);
    const rawLimit = command.options.get("--limit") as string | undefined;
    if (rawLimit !== undefined && (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200)) throw new UsageError("--limit must be a decimal integer from 1 to 200.", help);
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    const cursor = parseCursor(command.options.get("--cursor") as string | undefined, help);
    const before = parseCursor(command.options.get("--before") as string | undefined, help);
    const conversation = command.options.has("--conversation"), json = command.options.has("--json");
    await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
      operation.check();
      if (projectId === undefined) projectId = (await dependencies.resolveProject({ serverUrl, api, operation, workingDirectory: context.workingDirectory() })).id;
      operation.check();
      phase = "request";
      let value: unknown, output: string, partial = false;
      if (name === "current") {
        const current = await api.currentTaskSession(projectId, taskId!); value = current;
        partial = current.session !== null && taskObservationPartial(current.session.session);
        phase = "render"; output = json ? "" : renderTaskSessionCurrent(current, projectId, taskId!);
      } else if (name === "list") {
        const directory = await api.listTaskSessions(projectId, taskId!, { limit, ...(cursor === undefined ? {} : { cursor }) }); value = directory;
        phase = "render"; output = json ? "" : renderTaskSessionDirectory(directory, projectId, taskId!, limit);
      } else if (name === "show") {
        const inspection = await api.inspectTaskSession(projectId, taskId!, sessionId!); value = inspection;
        partial = taskObservationPartial(inspection.session);
        phase = "render"; output = json ? "" : renderTaskSessionInspection(inspection);
      } else if (name === "read") {
        const page = await api.readTaskSession(projectId, taskId!, sessionId!, { limit, conversation, ...(before === undefined ? {} : { before }) }); value = page;
        partial = page.coverage.state === "partial";
        phase = "render"; output = json ? "" : renderTaskSessionPage(page, projectId, taskId!, limit, conversation);
      } else {
        const chunk = await api.readTaskSessionEntry(projectId, taskId!, sessionId!, cursor!); value = chunk;
        phase = "render"; output = json ? "" : renderTaskSessionChunk(chunk, projectId, taskId!);
      }
      operation.check();
      if (json) output = `${stringifyApiJson(value)}\n`;
      phase = "output";
      await context.stdoutBytes(Buffer.from(output, "utf8"), operation.signal);
      if (partial) throw new PublicDiagnosticError("Session read is partial; the output retains its observed state and coverage.", 3, { cause: undefined });
    });
  } catch (cause) {
    if (cause instanceof PublicDiagnosticError) throw cause;
    throw new SessionReadCommandError(cause, name, phase, projectId, taskId, sessionId);
  }
};
