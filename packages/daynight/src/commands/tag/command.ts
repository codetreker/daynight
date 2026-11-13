import { ApiError } from "../../api/client.js";
import { parseVersionArgument } from "../../api/json.js";
import { canonicalId } from "../../api/validation.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import { parseCommand, renderCommandHelp } from "../../cli/schema.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { terminalText } from "../../platform/terminal.js";
import { isNonemptyText, isText } from "../../platform/text.js";
import type { resolveProject } from "../../repository/index.js";
import type { runServerCommand } from "../server/runtime.js";
import { confirmTeamChange, requireTeamConfirmation } from "../team/confirmation.js";
import { tagDefinition } from "./definition.js";
import { renderTag, renderTagJson, renderTagList } from "./rendering.js";

export type TagCommandDependencies = {
  runServerCommand: typeof runServerCommand;
  resolveProject: typeof resolveProject;
};

const defaults: TagCommandDependencies = {
  runServerCommand: async (...args) => (await import("../server/runtime.js")).runServerCommand(...args),
  resolveProject: async (...args) => (await import("../../repository/index.js")).resolveProject(...args),
};

export const runTagCommand = async (args: readonly string[], context: CliContext, dependencies: TagCommandDependencies = defaults): Promise<void> => {
  const command = parseCommand(tagDefinition, args, ["daynight", "tag"], "daynight tag --help");
  if (command.kind !== "run") {
    context.stdout(renderCommandHelp(command.command, command.path));
    return;
  }
  const action = command.command.name;
  const help = `${command.path.join(" ")} --help`;
  const rawProject = command.options.get("--project") as string | undefined;
  const projectId = rawProject === undefined ? undefined : canonicalId(rawProject);
  if (projectId === null) throw new UsageError("project-id must be a hyphenated UUID.", help);
  const rawTag = action === "show" || action === "rename" || action === "delete" ? command.values[0] : undefined;
  const tagId = rawTag === undefined ? undefined : canonicalId(rawTag);
  if (tagId === null) throw new UsageError("tag-id must be a hyphenated UUID.", help);
  const name = action === "create" ? command.values[0] : action === "rename" ? command.values[1] : undefined;
  if (name !== undefined && !isNonemptyText(name)) throw new UsageError("Tag name must be nonempty UTF-8 text without NUL characters.", help);
  const query = command.options.get("--query") as string | undefined;
  const cursor = command.options.get("--cursor") as string | undefined;
  if (query !== undefined && !isText(query)) throw new UsageError("query must be UTF-8 text without NUL characters.", help);
  if (cursor !== undefined && !isNonemptyText(cursor)) throw new UsageError("cursor must be nonempty UTF-8 text without NUL characters.", help);
  const rawLimit = command.options.get("--limit") as string | undefined;
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (rawLimit !== undefined && (!/^[0-9]+$/.test(rawLimit) || !Number.isInteger(limit) || limit! < 1 || limit! > 100)) throw new UsageError("limit must be a decimal integer from 1 to 100.", help);
  const rawVersion = command.options.get("--if-version") as string | undefined;
  let version: bigint | undefined;
  if (rawVersion !== undefined) {
    try { version = parseVersionArgument(rawVersion); }
    catch (cause) { throw new UsageError(cause instanceof Error ? cause.message : "version must be a positive 64-bit integer.", help); }
  }
  const confirmed = command.options.has("--confirm");
  if (action === "delete") requireTeamConfirmation(context, confirmed, "Tag deletion");
  await dependencies.runServerCommand(context, async (session) => {
    const { api, operation, serverUrl } = session;
    operation.check();
    const project = projectId === undefined
      ? await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })
      : await api.getProject(projectId);
    operation.check();
    const asJson = command.options.has("--json");
    if (action === "list") {
      const page = await api.listTags(project.id, { ...(query === undefined ? {} : { query }), ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
      operation.check();
      return asJson ? renderTagJson(page) : renderTagList(page, query !== undefined && query !== "", cursor !== undefined);
    }
    if (action === "show") {
      const tag = await api.getTag(project.id, tagId!);
      operation.check();
      return asJson ? renderTagJson(tag) : renderTag(tag);
    }
    if (action === "delete") {
      const preview = await api.getTag(project.id, tagId!);
      operation.check();
      context.stderr(`Delete Tag ${terminalText(JSON.stringify(preview.name))} (${preview.id}) in Project ${project.id}\nVersion: ${preview.version}\nVisible usage: ${preview.usage.tasks} Tasks, ${preview.usage.goals} Goals.\nAll associations will be removed, including those added after this preview.\n`);
      await confirmTeamChange(context, context.prompt?.isInteractive === true ? false : confirmed, "Confirm deletion of the Tag and all associations.", operation.signal, preview.name, "Tag deletion");
      operation.check();
      version ??= preview.version;
    } else if (action === "rename" && version === undefined) {
      version = (await api.getTag(project.id, tagId!)).version;
      operation.check();
    }
    let result;
    try {
      result = action === "create" ? await api.createTag(project.id, name!)
        : action === "rename" ? await api.renameTag(project.id, tagId!, name!, version!)
        : await api.deleteTag(project.id, tagId!, version!);
    } catch (cause) {
      if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Tag ${action} was confirmed for ${cause.confirmedMutationId}, but local request cleanup failed.`, 1, { cause });
      throw cause;
    }
    const resultId = action === "delete" ? tagId! : (result as { id: string }).id;
    const message = (phase: string) => `Tag ${action} was confirmed for ${resultId}, but local ${phase} failed.`;
    let output: string;
    try {
      output = asJson ? renderTagJson(result)
        : action === "delete" ? `Tag deleted.\nProject: ${project.id}\nID: ${tagId}\n`
        : `Tag ${action === "create" ? "created" : "renamed"}.\n${renderTag(result as Parameters<typeof renderTag>[0])}`;
    } catch (cause) { throw new PublicDiagnosticError(message("rendering"), 1, { cause }); }
    return { kind: "confirmed-mutation" as const, output, failureText: message };
  });
};
