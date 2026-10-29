import { describe, expect, it } from "vitest";
import type { GraphTask, TaskGraph, TaskStatus } from "../src/api/types";
import { buildGraphIndex, GraphDataError, projectChain, tracePrerequisites } from "../src/features/task-graph/model";

const id = (letter: string): string => `00000000-0000-0000-0000-${letter.charCodeAt(0).toString(16).padStart(12, "0")}`;
const [A, B, C, D, E, F, G, H, I] = ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map(id) as [string, string, string, string, string, string, string, string, string];
const time = "2026-10-20T00:00:00.123456Z";
type Seed = { readonly id: string; readonly status?: TaskStatus; readonly dependsOn?: readonly string[]; readonly externalDependsOn?: readonly string[] };
const graph = (seeds: readonly Seed[]): TaskGraph => {
  const tasks: GraphTask[] = seeds.map((seed) => {
    const dependsOn = seed.dependsOn ?? [];
    const status = seed.status ?? "todo";
    const blockedBy = dependsOn.filter((predecessor) => seeds.find((item) => item.id === predecessor)?.status !== "done");
    return { requiredPlatform: null, workerNeedsAttention: false, allowAgents: false, externalDependsOn: seed.externalDependsOn ?? [], startedAt: null, completedAt: null,
      id: seed.id, status, dependsOn, blockedBy, ready: status === "todo" && blockedBy.length === 0,
      titlePreview: "Private task text", titleTruncated: false, createdAt: time, updatedAt: time,
    };
  });
  const todo = tasks.filter((task) => task.status === "todo");
  return { observedAt: "2026-10-20T12:00:00Z",
    project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: id("P"), name: "Private project", repoUrl: "git@github.com:owner/repo.git", createdAt: time, updatedAt: time },
    tasks,
    summary: {
      total: tasks.length, todo: todo.length, inProgress: tasks.filter((task) => task.status === "in_progress").length,
      done: tasks.filter((task) => task.status === "done").length,
      ready: todo.filter((task) => task.ready).length, blocked: todo.filter((task) => !task.ready).length,
    },
  };
};

const changedTask = (input: TaskGraph, taskId: string, change: Partial<GraphTask>): TaskGraph => ({
  ...input, tasks: input.tasks.map((task) => task.id === taskId ? { ...task, ...change } : task),
});

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
};

const expectRejected = (input: unknown): void => {
  expect(() => buildGraphIndex(input as TaskGraph)).toThrow(GraphDataError);
  expect(() => buildGraphIndex(input as TaskGraph)).not.toThrow("Private");
};

describe("ordinary dependency components", () => {
  it("indexes an empty snapshot without inventing components or progress", () => {
    const index = buildGraphIndex(graph([]));
    expect(index.nodes.size).toBe(0);
    expect(index.successors.size).toBe(0);
    expect(index.representativeIds).toEqual([]);
    expect(index.components.size).toBe(0);
    expect(index.componentByTask.size).toBe(0);
    expect(() => projectChain(index, A)).toThrow(GraphDataError);
  });

  it("selects the first ordinary root using exact backend order rather than rounded timestamps or IDs", () => {
    const input = graph([{ id: B }, { id: A }, { id: C, dependsOn: [A, B] }, { id: D }]);
    const exact = input.tasks.map((task, position) => ({ ...task, createdAt: `2026-10-20T00:00:00.12345${position + 4}Z` }));
    const index = buildGraphIndex({ ...input, tasks: exact });
    expect(Date.parse(exact[0]!.createdAt)).toBe(Date.parse(exact[1]!.createdAt));
    expect(index.representativeIds).toEqual([B, D]);
    expect([...index.nodes.keys()]).toEqual([B, A, C, D]);
    expect(index.components.get(B)!.memberIds).toEqual(new Set([A, B, C]));
    expect(index.componentByTask.get(A)).toBe(B);
    const earlierDependent = buildGraphIndex(graph([{ id: C, dependsOn: [A, B] }, { id: A }, { id: B }]));
    expect(earlierDependent.representativeIds).toEqual([A]);
  });

  it.each([
    { root: "todo", child: "todo", done: 0, status: "todo" },
    { root: "in_progress", child: "todo", done: 0, status: "in_progress" },
    { root: "done", child: "todo", done: 1, status: "in_progress" },
    { root: "done", child: "in_progress", done: 1, status: "in_progress" },
    { root: "done", child: "done", done: 2, status: "done" },
  ] as const)("derives chain status $status from root $root and child $child", ({ root, child, done, status }) => {
    const index = buildGraphIndex(graph([{ id: A, status: root }, { id: B, status: child, dependsOn: [A] }]));
    expect(index.components.get(A)!.progress).toEqual({ total: 2, done, status });
  });

  it("counts diamond members once and retains a finished root's unfinished component", () => {
    const index = buildGraphIndex(graph([
      { id: A, status: "done" }, { id: B, status: "done", dependsOn: [A] },
      { id: C, status: "done", dependsOn: [A] }, { id: D, dependsOn: [B, C] },
    ]));
    expect(index.representativeIds).toEqual([A]);
    expect(index.successors.get(A)).toEqual([B, C]);
    expect(index.successors.get(D)).toEqual([]);
    expect(index.components.get(A)!.progress).toEqual({ total: 4, done: 3, status: "in_progress" });
    const projection = projectChain(index, A);
    expect(projection.mainIds).toEqual(new Set([A, B, C, D]));
    expect(projection.externalIds.size).toBe(0);
    expect(projection.completed).toBe(3);
    expect(projection.edges).toHaveLength(4);
    expect(projection.edges.every((edge) => !edge.external)).toBe(true);
    expect(new Set(projection.edges.map((edge) => `${edge.source}:${edge.target}`)).size).toBe(4);
  });

  it("merges ordinary multi-root joins into one component with unique membership and progress", () => {
    const index = buildGraphIndex(graph([
      { id: A, status: "done" }, { id: B, status: "done" }, { id: C, status: "done" },
      { id: D, status: "done", dependsOn: [A, B] }, { id: E, dependsOn: [D, C] }, { id: F, dependsOn: [E] },
      { id: G, status: "in_progress" },
    ]));
    expect(index.representativeIds).toEqual([A, G]);
    expect(index.components.get(A)!.memberIds).toEqual(new Set([A, B, C, D, E, F]));
    expect(index.components.get(A)!.progress).toEqual({ total: 6, done: 4, status: "in_progress" });
    expect(index.components.get(G)!.progress).toEqual({ total: 1, done: 0, status: "in_progress" });
    expect(index.componentByTask.size).toBe(7);
    for (const member of [A, B, C, D, E, F]) expect(index.componentByTask.get(member)).toBe(A);
    expect([...index.components.values()].reduce((total, component) => total + component.memberIds.size, 0)).toBe(index.nodes.size);
    expect(projectChain(index, A).externalIds.size).toBe(0);
    expect(() => projectChain(index, B)).toThrow(GraphDataError);
  });

  it("keeps external-only tasks in singleton components while preserving their blocking and successors", () => {
    const index = buildGraphIndex(graph([
      { id: A }, { id: B, dependsOn: [A], externalDependsOn: [A] },
      { id: C, dependsOn: [B], externalDependsOn: [B] },
    ]));
    expect(index.representativeIds).toEqual([A, B, C]);
    for (const member of [A, B, C]) expect(index.components.get(member)!.memberIds).toEqual(new Set([member]));
    expect(index.nodes.get(B)).toMatchObject({ blockedBy: [A], ready: false });
    expect(index.successors.get(B)).toEqual([C]);
    expect(projectChain(index, B)).toMatchObject({ rootId: B, mainIds: new Set([B]), externalIds: new Set([A]), completed: 0 });
  });

  it("merges and splits membership when only edge classification changes", () => {
    const input = graph([{ id: A }, { id: B }, { id: C, dependsOn: [A, B], externalDependsOn: [B] }]);
    const separate = buildGraphIndex(input);
    expect(separate.representativeIds).toEqual([A, B]);
    expect(separate.components.get(A)!.memberIds).toEqual(new Set([A, C]));
    const merged = buildGraphIndex(changedTask(input, C, { externalDependsOn: [] }));
    expect(merged.representativeIds).toEqual([A]);
    expect(merged.componentByTask.get(B)).toBe(A);
    const split = buildGraphIndex(changedTask(input, C, { externalDependsOn: [A, B] }));
    expect(split.representativeIds).toEqual([A, B, C]);
    expect(split.componentByTask.get(C)).toBe(C);
    expect(split.nodes.get(C)!.updatedAt).toBe(merged.nodes.get(C)!.updatedAt);
    expect(split.nodes.get(C)!.blockedBy).toEqual(merged.nodes.get(C)!.blockedBy);
    expect(separate.components.get(A)!.progress.total).toBe(2);
    expect(merged.components.get(A)!.progress.total).toBe(3);
    expect(split.components.get(C)!.progress.total).toBe(1);
  });

  it("partitions a captured 31-task, 61-edge topology into one 23-member chain and eight singletons", () => {
    // We preserve the complete topology and exact task order from the 2026-10-23T17:45:03.946Z capture
    // (SHA-256 0ae4c40a06ffe6b1c5a1dcada086dd887dd8e84157ed1e1131b5a3be8d545daf). Task IDs and titles
    // are omitted. The captured service exposed no classification, so every edge here is ordinary.
    const dependencies: readonly (readonly number[])[] = [[], [0], [], [], [2,3], [2,1], [3], [6,3], [5,6,3], [5,3], [8,5,6,3], [4,2,8,6,3], [2,9,5,3], [7,12,5,3], [12,13,8,6,11,10,3], [7,1,8,11], [15,12,9,13,8,5,11,10,14], [12,9,16], [], [17,16,18], [3], [], [], [5,10,3], [], [], [5], [], [], [], []];
    const names = dependencies.map((_, position) => `captured-${position}`);
    const index = buildGraphIndex(graph(dependencies.map((predecessors, position) => ({
      id: names[position]!, dependsOn: predecessors.map((source) => names[source]!),
    }))));
    const singletonPositions = [21, 22, 24, 25, 27, 28, 29, 30];
    expect(index.nodes.size).toBe(31);
    expect(dependencies.reduce((total, items) => total + items.length, 0)).toBe(61);
    expect(index.representativeIds).toEqual([names[0]!, ...singletonPositions.map((position) => names[position]!)]);
    expect(index.components.get(names[0]!)!.memberIds).toEqual(new Set(names.filter((_, position) => !singletonPositions.includes(position))));
    expect(index.components.get(names[0]!)!.progress).toEqual({ total: 23, done: 0, status: "todo" });
    expect(projectChain(index, names[0]!).edges).toHaveLength(61);
    for (const position of singletonPositions) expect(index.components.get(names[position]!)!.memberIds.size).toBe(1);
  });

  it("counts all waiting tasks and preserves their prerequisite details", () => {
    const input = graph([
      { id: A, status: "todo" }, { id: B, status: "todo", dependsOn: [A] },
      { id: C, status: "todo", dependsOn: [A] }, { id: D, status: "done" },
      { id: E, status: "todo", dependsOn: [D] },
    ]);
    const index = buildGraphIndex(input);
    expect(input.summary).toEqual({ total: 5, todo: 4, inProgress: 0, done: 1, ready: 2, blocked: 2 });
    expect(index.nodes.get(A)).toMatchObject({ ready: true, blockedBy: [] });
    expect(index.nodes.get(B)).toMatchObject({ ready: false, blockedBy: [A] });
    expect(index.nodes.get(E)).toMatchObject({ ready: true, blockedBy: [] });
  });

  it("accepts unordered blocked sets and preserves snapshots and independent projection sets", () => {
    const input = changedTask(graph([{ id: A }, { id: B }, { id: C, dependsOn: [A, B] }]), C, { blockedBy: [B, A] });
    const original = structuredClone(input);
    const index = buildGraphIndex(deepFreeze(input));
    const first = projectChain(index, A);
    const second = projectChain(index, A);
    expect(first).toEqual(second);
    expect(first.mainIds).not.toBe(second.mainIds);
    expect(input).toEqual(original);
    expect(index.nodes.get(A)).toBe(input.tasks[0]);
    const later = buildGraphIndex(graph([{ id: A, status: "done" }]));
    expect(later.components.get(A)!.progress).toEqual({ total: 1, done: 1, status: "done" });
    expect(index.components.get(A)!.progress).toEqual({ total: 3, done: 0, status: "todo" });
  });

  it("handles a long permitted ordinary chain iteratively", () => {
    const seeds = Array.from({ length: 1000 }, (_, position) => ({
      id: `00000000-0000-0000-0000-${position.toString(16).padStart(12, "0")}`,
      ...(position === 0 ? {} : { dependsOn: [`00000000-0000-0000-0000-${(position - 1).toString(16).padStart(12, "0")}`] }),
    }));
    const index = buildGraphIndex(graph(seeds));
    expect(projectChain(index, seeds[0]!.id).mainIds.size).toBe(1000);
    expect(index.components.get(seeds[0]!.id)!.progress).toEqual({ total: 1000, done: 0, status: "todo" });
  });
});

describe("complete prerequisite projection", () => {
  it("keeps an external shortcut dashed when both endpoints remain ordinary-connected members", () => {
    const index = buildGraphIndex(graph([
      { id: A, status: "done" }, { id: B, status: "done", dependsOn: [A] },
      { id: C, dependsOn: [A, B], externalDependsOn: [A] },
    ]));
    expect(index.representativeIds).toEqual([A]);
    const projection = projectChain(index, A);
    expect(projection.mainIds).toEqual(new Set([A, B, C]));
    expect(projection.externalIds.size).toBe(0);
    expect(projection.edges).toEqual([
      { source: A, target: B, external: false },
      { source: A, target: C, external: true }, { source: B, target: C, external: false },
    ]);
  });

  it("includes recursive external prerequisites with their original edge flags and excludes unrelated successors", () => {
    const index = buildGraphIndex(graph([
      { id: A, status: "done" }, { id: B }, { id: C, status: "done" },
      { id: D, status: "done", dependsOn: [A] }, { id: E, dependsOn: [B] }, { id: F, status: "done", dependsOn: [C] },
      { id: G, dependsOn: [D, E, F], externalDependsOn: [E, F] }, { id: H, dependsOn: [G] }, { id: I, dependsOn: [E] },
    ]));
    const projection = projectChain(index, A);
    expect(projection.mainIds).toEqual(new Set([A, D, G, H]));
    expect(projection.externalIds).toEqual(new Set([B, C, E, F]));
    expect(projection.externalIds.has(I)).toBe(false);
    expect(projection.completed).toBe(2);
    expect(index.components.get(A)!.progress).toEqual({ total: 4, done: 2, status: "in_progress" });
    expect(projection.edges).toEqual([
      { source: A, target: D, external: false }, { source: B, target: E, external: false },
      { source: C, target: F, external: false }, { source: D, target: G, external: false },
      { source: E, target: G, external: true }, { source: F, target: G, external: true },
      { source: G, target: H, external: false },
    ]);
    expect(index.nodes.get(E)?.blockedBy).toEqual([B]);
  });

  it("starts at a normal root with external predecessors and does not include its external successors", () => {
    const index = buildGraphIndex(graph([
      { id: B }, { id: A, dependsOn: [B], externalDependsOn: [B] },
      { id: C, dependsOn: [A] }, { id: D, dependsOn: [C], externalDependsOn: [C] },
    ]));
    expect(index.representativeIds).toEqual([B, A, D]);
    const projection = projectChain(index, A);
    expect(projection.mainIds).toEqual(new Set([A, C]));
    expect(projection.externalIds).toEqual(new Set([B]));
    expect(projection.edges).toEqual([{ source: B, target: A, external: true }, { source: A, target: C, external: false }]);
    expect(projectChain(index, B).mainIds).toEqual(new Set([B]));
    expect(projectChain(index, B).edges).toEqual([]);
  });

  it("keeps waiting members todo and external progress outside its counters", () => {
    const index = buildGraphIndex(graph([
      { id: A, status: "todo" }, { id: B, status: "todo" },
      { id: C, status: "todo", dependsOn: [A, B], externalDependsOn: [B] },
      { id: D, status: "todo", dependsOn: [A, C] }, { id: E, dependsOn: [B] },
    ]));
    expect(projectChain(index, A).mainIds).toEqual(new Set([A, C, D]));
    expect(projectChain(index, A).externalIds).toEqual(new Set([B]));
    expect(index.components.get(A)!.progress).toEqual({ total: 3, done: 0, status: "todo" });
    expect(index.components.get(B)!.progress).toEqual({ total: 2, done: 0, status: "todo" });
  });

  it("permits shared external context without overlapping actual membership", () => {
    const index = buildGraphIndex(graph([
      { id: A }, { id: B }, { id: C, dependsOn: [A, E], externalDependsOn: [E] },
      { id: D, dependsOn: [B, E], externalDependsOn: [E] }, { id: E }, { id: F, dependsOn: [E] },
    ]));
    expect(projectChain(index, A).mainIds).toEqual(new Set([A, C]));
    expect(projectChain(index, B).mainIds).toEqual(new Set([B, D]));
    expect(projectChain(index, A).externalIds).toEqual(new Set([E]));
    expect(projectChain(index, B).externalIds).toEqual(new Set([E]));
    expect(index.componentByTask.get(E)).toBe(E);
    expect(index.components.get(E)!.memberIds).toEqual(new Set([E, F]));
    expect(index.nodes.size).toBe(6);
  });

  it.each(["done", "in_progress"] as const)("excludes an external %s prerequisite from the chain's status", (status) => {
    const index = buildGraphIndex(graph([{ id: A }, { id: B, status }, { id: C, dependsOn: [A, B], externalDependsOn: [B] }]));
    expect(projectChain(index, A).externalIds).toEqual(new Set([B]));
    expect(index.components.get(A)!.progress).toEqual({ total: 2, done: 0, status: "todo" });
    expect(index.components.get(B)!.progress).toEqual({ total: 1, done: status === "done" ? 1 : 0, status });
  });

  it("deduplicates completed shared ancestors and follows deep external context iteratively", () => {
    const ancestors = Array.from({ length: 996 }, (_, position) => ({
      id: `external-${position}`, status: "done" as const,
      dependsOn: position === 0 ? [] : [`external-${position - 1}`],
    }));
    const index = buildGraphIndex(graph([
      { id: A }, ...ancestors,
      { id: B, status: "done", dependsOn: [ancestors.at(-1)!.id] },
      { id: C, status: "done", dependsOn: [ancestors.at(-1)!.id] },
      { id: D, dependsOn: [A, B, C], externalDependsOn: [B, C] },
    ]));
    const projection = projectChain(index, A);
    expect(projection.mainIds).toEqual(new Set([A, D]));
    expect(projection.externalIds.size).toBe(998);
    expect(projection.edges).toHaveLength(1000);
    expect(projection.completed).toBe(0);
    expect(index.components.get(A)!.progress).toEqual({ total: 2, done: 0, status: "todo" });
    expect(projection.edges.filter((edge) => edge.external)).toHaveLength(2);
  });

  it("rejects unavailable representatives without returning a partial projection", () => {
    const index = buildGraphIndex(graph([{ id: A }, { id: B, dependsOn: [A] }]));
    expect(() => projectChain(index, B)).toThrow(GraphDataError);
    expect(() => projectChain(index, C)).toThrow(GraphDataError);
  });
});

describe("complete prerequisite inspection", () => {
  it("deduplicates shared completed and waiting prerequisites without following successors", () => {
    const input = deepFreeze(graph([
      { id: A, status: "done" }, { id: B, status: "done", dependsOn: [A] },
      { id: C, status: "todo", dependsOn: [A] }, { id: D, dependsOn: [B, C] },
      { id: E, dependsOn: [A] }, { id: F, dependsOn: [D] },
    ]));
    const index = buildGraphIndex(input);
    expect(tracePrerequisites(index, D)).toEqual(new Set([D, B, C, A]));
    expect(tracePrerequisites(index, A)).toEqual(new Set([A]));
    expect(index.components.get(A)!.progress).toEqual({ total: 6, done: 2, status: "in_progress" });
    expect(input.tasks.find((task) => task.id === D)!.dependsOn).toEqual([B, C]);
  });

  it("traverses the full index iteratively even when nearly every ancestor is folded", () => {
    const seeds = Array.from({ length: 1000 }, (_, position) => ({
      id: `ancestor-${position}`, dependsOn: position === 0 ? [] : [`ancestor-${position - 1}`],
    }));
    const index = buildGraphIndex(graph(seeds));
    expect(tracePrerequisites(index, "ancestor-999")).toEqual(new Set(seeds.map((seed) => seed.id)));
    expect(tracePrerequisites(index, "ancestor-0")).toEqual(new Set(["ancestor-0"]));
  });

  it("returns independent inspection sets and rejects unknown selection identities", () => {
    const index = buildGraphIndex(graph([{ id: A }, { id: B, dependsOn: [A] }]));
    const first = tracePrerequisites(index, B);
    expect(tracePrerequisites(index, B)).not.toBe(first);
    expect(() => tracePrerequisites(index, C)).toThrow(GraphDataError);
  });
});

describe("external dependency read metadata", () => {
  it("preserves readiness and cycle validation across every dependency edge", () => {
    const blocked = changedTask(graph([
      { id: A }, { id: C, status: "done" }, { id: B, dependsOn: [A, C] },
    ]), B, { externalDependsOn: [A, C] });
    expect(buildGraphIndex(blocked).nodes.get(B)).toMatchObject({
      dependsOn: [A, C], externalDependsOn: [A, C], blockedBy: [A], ready: false,
    });
    expectRejected(changedTask(blocked, B, { blockedBy: [] }));
    expectRejected(changedTask(blocked, B, { ready: true }));

    const ready = changedTask(graph([
      { id: A, status: "done" }, { id: C, status: "done" }, { id: B, dependsOn: [A, C] },
    ]), B, { externalDependsOn: [A, C] });
    expect(buildGraphIndex(ready).nodes.get(B)).toMatchObject({
      externalDependsOn: [A, C], blockedBy: [], ready: true,
    });

    const mixedCycle = changedTask(graph([
      { id: A, dependsOn: [B] }, { id: B, dependsOn: [A] },
    ]), B, { externalDependsOn: [A] });
    expectRejected(mixedCycle);
    expectRejected(changedTask(mixedCycle, A, { externalDependsOn: [B] }));
  });
});

describe("invalid graph snapshots", () => {
  const valid = graph([{ id: A }, { id: B, dependsOn: [A] }]);

  it.each([
    null, undefined, [], { tasks: [] }, { tasks: [], summary: null }, { tasks: null, summary: {} },
    { ...valid, tasks: [null] }, { ...valid, tasks: [{ ...valid.tasks[0], id: null }] },
    { ...valid, tasks: [{ ...valid.tasks[0], id: "" }] },
    { ...valid, tasks: [...valid.tasks, valid.tasks[0]] },
    changedTask(valid, B, { dependsOn: [C], blockedBy: [C] }),
    changedTask(valid, B, { dependsOn: [B], blockedBy: [B] }),
    changedTask(valid, B, { dependsOn: [A, A] }),
    changedTask(valid, B, { blockedBy: [A, A] }),
    changedTask(valid, B, { externalDependsOn: [A, A] }),
    changedTask(valid, B, { externalDependsOn: [C] }),
    ...["dependsOn", "externalDependsOn", "blockedBy", "status", "ready"].flatMap((field) => [undefined, null, 1].map((value) =>
      ({ ...valid, tasks: valid.tasks.map((task) => task.id === B ? { ...task, [field]: value } : task) }))),
    changedTask(valid, B, { status: "pending" as TaskStatus }),
    changedTask(valid, B, { blockedBy: [] }),
    changedTask(valid, A, { blockedBy: [C] }),
    changedTask(valid, B, { blockedBy: [C] }),
    changedTask(valid, B, { ready: true }),
    changedTask(valid, A, { ready: false }),
    graph([{ id: A }, { id: B, status: "in_progress", dependsOn: [A] }]),
    graph([{ id: A }, { id: B, status: "done", dependsOn: [A] }]),
    changedTask(graph([{ id: A, status: "done" }]), A, { ready: true }),
    changedTask(graph([{ id: A, status: "in_progress" }]), A, { ready: true }),
    changedTask(valid, A, { status: "proposed" as TaskStatus }),
    graph([{ id: A, dependsOn: [B] }, { id: B, dependsOn: [A] }]),
    graph([{ id: A }, { id: B, dependsOn: [C] }, { id: C, dependsOn: [D] }, { id: D, dependsOn: [B] }]),
    ...["total", "todo", "inProgress", "done", "ready", "blocked"].flatMap((field) => [-1, 99, null, undefined, "0"].map((value) =>
      ({ ...valid, summary: { ...valid.summary, [field]: value } }))),
  ])("rejects incomplete or inconsistent input %# with a safe error", expectRejected);

  it("accepts exactly the edge limit and refuses oversized snapshots before projection", () => {
    const roots = Array.from({ length: 100 }, (_, position) => ({
      id: `10000000-0000-0000-0000-${position.toString(16).padStart(12, "0")}`,
    }));
    const leaves = Array.from({ length: 50 }, (_, position) => ({
      id: `20000000-0000-0000-0000-${position.toString(16).padStart(12, "0")}`,
      dependsOn: roots.map((root) => root.id),
    }));
    const index = buildGraphIndex(graph([...roots, ...leaves]));
    expect(index.nodes.size).toBe(150);
    expect(projectChain(index, roots[0]!.id).edges).toHaveLength(5000);
    const oversized = graph([...roots, ...leaves, { id: A, dependsOn: [roots[0]!.id] }]);
    expect(() => buildGraphIndex(oversized)).toThrow("exceeds the supported size");
    expect(() => buildGraphIndex(graph(Array.from({ length: 1001 }, (_, position) => ({ id: String(position) }))))).toThrow("exceeds the supported size");
  });
});
