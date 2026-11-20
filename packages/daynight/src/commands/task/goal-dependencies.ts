import { ApiError } from "../../api/client.js";
import { PublicDiagnosticError } from "../../platform/diagnostics.js";
import { canonicalId } from "../../api/validation.js";
import { validGoalRevision } from "../../api/goal-dependencies.js";
import type { GoalDependencyEdit, GoalDependencyTarget } from "../../api/goal-dependencies.js";
import { UsageError } from "../../cli/context.js";
import type { CliContext } from "../../cli/context.js";
import type { ParsedCommand } from "../../cli/schema.js";
import { isNonemptyText } from "../../platform/text.js";
import { terminalText } from "../../platform/terminal.js";
import type { TaskCommandDependencies } from "./command.js";

const renderTarget = (value: GoalDependencyTarget): string => `${terminalText(value.projectName)} (${value.projectId}) / ${terminalText(value.title)} (${value.goalId}) — ${value.kind}, ${value.status}`;
export const runGoalDependenciesCommand = async (command: Extract<ParsedCommand, { readonly kind: "run" }>, context: CliContext, dependencies: TaskCommandDependencies): Promise<void> => {
  const help = `${command.path.join(" ")} --help`, action = command.command.name;
  const parseId = (value: string, label: string): string => {
    const result = canonicalId(value);
    if (result === null) throw new UsageError(`${label} must be a hyphenated UUID.`, help);
    return result;
  };
  const goal = parseId(command.values[0]!, "goal-id");
  const rawProject = command.options.get("--project") as string | undefined;
  const project = rawProject === undefined ? undefined : parseId(rawProject, "project-id");
  const rawLimit = command.options.get("--limit") as string | undefined;
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (rawLimit !== undefined && (!/^[0-9]+$/.test(rawLimit) || !Number.isInteger(limit) || limit! < 1 || limit! > 50)) throw new UsageError("limit must be an integer from 1 to 50.", help);
  const cursor = command.options.get("--cursor") as string | undefined;
  if (cursor !== undefined && !isNonemptyText(cursor)) throw new UsageError("cursor must be nonempty Unicode text without NUL.", help);
  const revision = command.options.get("--if-revision") as string | undefined;
  if (revision !== undefined && !validGoalRevision(revision)) throw new UsageError("revision must be a canonical positive int64 decimal string.", help);
  const targets = ((command.options.get("--target") as readonly string[] | undefined) ?? []).map(value => {
    const parts = value.split("/");
    if (parts.length !== 2) throw new UsageError("target must be project-uuid/goal-uuid.", help);
    return { projectId: parseId(parts[0]!, "target project-id"), goalId: parseId(parts[1]!, "target goal-id") };
  });
  const edges = ((command.options.get("--edge") as readonly string[] | undefined) ?? []).map(value => parseId(value, "edge-id"));
  const clear = command.options.has("--clear");
  if (new Set(targets.map(value => `${value.projectId}/${value.goalId}`)).size !== targets.length || new Set(edges).size !== edges.length) throw new UsageError("Duplicate targets or edges are not allowed.", help);
  if (targets.length > 30 || edges.length > 30 || action === "replace" && targets.length + edges.length > 30) throw new UsageError("At most 30 prerequisites may be supplied.", help);
  if (action === "add" && targets.length === 0 || action === "remove" && edges.length === 0) throw new UsageError(`At least one ${action === "add" ? "--target" : "--edge"} is required.`, help);
  if (action === "replace" && (clear ? targets.length + edges.length > 0 : targets.length + edges.length === 0)) throw new UsageError("Replace requires --target or --edge, or --clear alone.", help);
  await dependencies.runServerCommand(context, async ({ api, operation, serverUrl }) => {
    const projectId = project ?? (await dependencies.resolveProject({ serverUrl, operation, api, workingDirectory: context.workingDirectory() })).id;
    operation.check();
    if (action === "show") {
      const result = await api.showGoalDependencies(projectId, goal, { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
      operation.check();
      if (command.options.has("--json")) return `${JSON.stringify(result)}\n`;
      const lines = [`Goal: ${result.goalId}`, `Can edit: ${result.canEdit}`, ...(result.revision === undefined ? [] : [`Revision: ${result.revision}`]), `Completion blocked: ${result.completionBlocked}`, "Prerequisites:"];
      for (const item of result.prerequisites) lines.push(`  ${item.edgeId === undefined ? "" : `edge ${item.edgeId}: `}${item.target === null ? "Hidden target" : renderTarget(item.target)}`);
      lines.push("Successors:");
      for (const item of result.successors) lines.push(`  ${renderTarget(item)}`);
      lines.push(`Next cursor: ${result.nextCursor === null ? "none" : terminalText(result.nextCursor)}`);
      return `${lines.join("\n")}\n`;
    }
    let current = revision;
    if (current === undefined) {
      const snapshot = await api.showGoalDependencies(projectId, goal);
      operation.check();
      if (!snapshot.canEdit || snapshot.revision === undefined) throw new Error("Goal dependencies cannot be edited by this caller; no update was submitted.");
      current = snapshot.revision;
    }
    const input: GoalDependencyEdit = action === "add" ? { ifRevision: current, mode: "edit", add: targets }
      : action === "remove" ? { ifRevision: current, mode: "edit", remove: edges }
      : { ifRevision: current, mode: "replace", prerequisites: [...targets, ...edges.map(edgeId => ({ edgeId }))] };
    let result;
    try { result = await api.editGoalDependencies(projectId, goal, input); }
    catch (cause) {
      if (cause instanceof ApiError && cause.confirmedMutationId !== undefined) throw new PublicDiagnosticError(`Goal dependency edit was confirmed for ${goal}, but local request cleanup failed.`, 1, { cause });
      throw cause;
    }
    const output = command.options.has("--json") ? `${JSON.stringify(result)}\n` : `Goal dependencies updated.\nGoal: ${result.goalId}\nRevision: ${result.revision}\nChanged: ${result.changed}\n`;
    return { kind: "confirmed-mutation" as const, output, failureText: (phase: string) => `Goal dependency edit was confirmed for ${goal}, but local ${phase} failed.` };
  }).catch((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 404) throw new Error(`${cause.message} Goal or relationship route may be unavailable; check the Goal and server version.`, { cause });
    throw cause;
  });
};
