import { isTerminalStatus, taskProgressStatus, type TaskProgressStatus } from "../../api/task-status";
import type { GraphTask, TaskGraph, TaskGraphSummary, TaskStatus } from "../../api/types";

export type ComponentProgress = {
  readonly total: number;
  readonly done: number;
  readonly cancelled: number;
  readonly ended: number;
  readonly status: TaskProgressStatus;
};

export type TaskComponent = {
  readonly memberIds: ReadonlySet<string>;
  readonly progress: ComponentProgress;
};

export type GraphIndex = {
  readonly nodes: ReadonlyMap<string, GraphTask>;
  readonly successors: ReadonlyMap<string, readonly string[]>;
  readonly representativeIds: readonly string[];
  readonly components: ReadonlyMap<string, TaskComponent>;
  readonly componentByTask: ReadonlyMap<string, string>;
};

export type ProjectionEdge = {
  readonly source: string;
  readonly target: string;
  readonly external: boolean;
};

export type ChainProjection = {
  readonly rootId: string;
  readonly mainIds: ReadonlySet<string>;
  readonly externalIds: ReadonlySet<string>;
  readonly edges: readonly ProjectionEdge[];
  readonly completed: number;
};

export class GraphDataError extends Error {
  constructor(reason: "invalid" | "limit" = "invalid") {
    super(reason === "limit" ? "Task graph exceeds the supported size." : "Task graph data is incomplete or inconsistent.");
    this.name = "GraphDataError";
  }
}

const rejectGraph = (): never => {
  throw new GraphDataError();
};

export const buildGraphIndex = (graph: TaskGraph): GraphIndex => {
  if (typeof graph !== "object" || graph === null || !Array.isArray(graph.tasks) ||
    typeof graph.summary !== "object" || graph.summary === null) return rejectGraph();
  if (graph.tasks.length > 1000) throw new GraphDataError("limit");
  const nodes = new Map<string, GraphTask>();
  const successors = new Map<string, string[]>();
  const executionRoots: string[] = [];
  const ordinaryNeighbors = new Map<string, string[]>();
  const ordinaryIndegrees = new Map<string, number>();
  const order = new Map<string, number>();
  let edgeCount = 0;
  for (const task of graph.tasks) {
    if (typeof task !== "object" || task === null || typeof task.id !== "string" || task.id === "" || nodes.has(task.id) ||
      !Array.isArray(task.dependsOn) || !Array.isArray(task.externalDependsOn) || !Array.isArray(task.blockedBy) ||
      (task.status !== "todo" && task.status !== "in_progress" && task.status !== "done" && task.status !== "cancelled") || typeof task.ready !== "boolean") {
      return rejectGraph();
    }
    edgeCount += task.dependsOn.length;
    if (edgeCount > 5000) throw new GraphDataError("limit");
    const dependencies = new Set<string>(task.dependsOn);
    const external = new Set<string>(task.externalDependsOn);
    if (dependencies.size !== task.dependsOn.length || external.size !== task.externalDependsOn.length ||
      [...external].some((id) => !dependencies.has(id)) || new Set(task.blockedBy).size !== task.blockedBy.length) {
      return rejectGraph();
    }
    order.set(task.id, nodes.size);
    nodes.set(task.id, task);
    ordinaryNeighbors.set(task.id, []);
    ordinaryIndegrees.set(task.id, task.dependsOn.length - task.externalDependsOn.length);
    successors.set(task.id, []);
    if (task.dependsOn.length === 0) executionRoots.push(task.id);
  }

  const actual: { -readonly [Key in keyof TaskGraphSummary]: number } = {
    total: nodes.size, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0,
  };
  for (const task of nodes.values()) {
    const blocked = new Set<string>();
    const external = new Set(task.externalDependsOn);
    for (const predecessorId of task.dependsOn) {
      const predecessor = nodes.get(predecessorId);
      if (predecessor === undefined || predecessorId === task.id) return rejectGraph();
      successors.get(predecessorId)!.push(task.id);
      if (!external.has(predecessorId)) {
        ordinaryNeighbors.get(task.id)!.push(predecessorId);
        ordinaryNeighbors.get(predecessorId)!.push(task.id);
      }
      if (!isTerminalStatus(predecessor.status)) blocked.add(predecessorId);
    }
    if (blocked.size !== task.blockedBy.length || task.blockedBy.some((id) => !blocked.has(id)) ||
      task.ready !== (task.status === "todo" && blocked.size === 0) ||
      ((task.status === "in_progress" || task.status === "done") && blocked.size !== 0)) return rejectGraph();
    if (task.status === "todo") {
      actual.todo++;
      if (task.ready) actual.ready++;
      else actual.blocked++;
    } else if (task.status === "in_progress") actual.inProgress++;
    else if (task.status === "done") actual.done++;
    else actual.cancelled++;
  }
  for (const key of Object.keys(actual) as (keyof TaskGraphSummary)[]) {
    if (graph.summary[key] !== actual[key]) return rejectGraph();
  }

  const degrees = new Map([...nodes.values()].map((task) => [task.id, task.dependsOn.length]));
  const pending = [...executionRoots];
  for (let position = 0; position < pending.length; position++) {
    for (const successor of successors.get(pending[position]!)!) {
      const degree = degrees.get(successor)! - 1;
      degrees.set(successor, degree);
      if (degree === 0) pending.push(successor);
    }
  }
  if (pending.length !== nodes.size) return rejectGraph();

  const componentByTask = new Map<string, string>();
  const discovered = new Map<string, TaskComponent>();
  for (const first of nodes.keys()) {
    if (componentByTask.has(first)) continue;
    const memberIds = new Set([first]);
    const members = [first];
    let representative: string | undefined;
    let done = 0;
    let cancelled = 0;
    let inProgress = false;
    for (let position = 0; position < members.length; position++) {
      const id = members[position]!;
      if (ordinaryIndegrees.get(id) === 0 && (representative === undefined || order.get(id)! < order.get(representative)!)) representative = id;
      const status = nodes.get(id)!.status;
      if (status === "done") done++;
      else if (status === "cancelled") cancelled++;
      else if (status === "in_progress") inProgress = true;
      for (const neighbor of ordinaryNeighbors.get(id)!) {
        if (memberIds.has(neighbor)) continue;
        memberIds.add(neighbor);
        members.push(neighbor);
      }
    }
    if (representative === undefined) return rejectGraph();
    const status = taskProgressStatus(done, cancelled, members.length, inProgress);
    for (const id of memberIds) componentByTask.set(id, representative);
    discovered.set(representative, { memberIds, progress: { total: members.length, done, cancelled, ended: done + cancelled, status } });
  }
  const representativeIds = [...nodes.keys()].filter((id) => discovered.has(id));
  const components = new Map(representativeIds.map((id) => [id, discovered.get(id)!]));
  return { nodes, successors, representativeIds, components, componentByTask };
};

export const projectChain = (index: GraphIndex, rootId: string): ChainProjection => {
  const component = index.components.get(rootId);
  if (component === undefined) return rejectGraph();
  const mainIds = new Set([...index.nodes.keys()].filter((id) => component.memberIds.has(id)));
  const visibleIds = new Set(mainIds);
  const pending = [...mainIds];
  while (pending.length > 0) {
    for (const source of index.nodes.get(pending.pop()!)!.dependsOn) {
      if (visibleIds.has(source)) continue;
      visibleIds.add(source);
      pending.push(source);
    }
  }
  const externalIds = new Set<string>();
  const edges: ProjectionEdge[] = [];
  for (const task of index.nodes.values()) {
    if (!visibleIds.has(task.id)) continue;
    if (!mainIds.has(task.id)) externalIds.add(task.id);
    const external = new Set(task.externalDependsOn);
    for (const source of task.dependsOn) {
      edges.push({ source, target: task.id, external: external.has(source) });
    }
  }
  return { rootId, mainIds, externalIds, edges, completed: component.progress.done };
};

export const tracePrerequisites = (index: GraphIndex, taskId: string): ReadonlySet<string> => {
  if (!index.nodes.has(taskId)) return rejectGraph();
  const result = new Set<string>();
  const pending = [taskId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const source of index.nodes.get(id)!.dependsOn) pending.push(source);
  }
  return result;
};
