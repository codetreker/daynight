import './local-only';
import { describe, expect, it } from "vitest";
import { buildGraphIndex, projectChain, tracePrerequisites } from "../../src/features/task-graph/model";
import { graph } from "../graph-model-fixture";

const [A, B, C, D] = ["A", "B", "C", "D"].map((letter) => `00000000-0000-0000-0000-${letter.charCodeAt(0).toString(16).padStart(12, "0")}`) as [string, string, string, string];

describe("complete graph-model capacity", () => {
  it("handles a long permitted ordinary chain iteratively", () => {
    const seeds = Array.from({ length: 1000 }, (_, position) => ({
      id: `00000000-0000-0000-0000-${position.toString(16).padStart(12, "0")}`,
      ...(position === 0 ? {} : { dependsOn: [`00000000-0000-0000-0000-${(position - 1).toString(16).padStart(12, "0")}`] }),
    }));
    const index = buildGraphIndex(graph(seeds));
    expect(projectChain(index, seeds[0]!.id).mainIds.size).toBe(1000);
    expect(index.components.get(seeds[0]!.id)!.progress).toEqual({ total: 1000, done: 0, status: "todo" });
  });
  it("limits external context to one hop while tracing deep shared ancestors iteratively", () => {
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
    expect(projection.externalIds).toEqual(new Set([B, C]));
    expect(tracePrerequisites(index, D)).toEqual(new Set([A, B, C, D, ...ancestors.map(({ id }) => id)]));
    expect(projection.edges).toHaveLength(3);
    expect(projection.completed).toBe(0);
    expect(index.components.get(A)!.progress).toEqual({ total: 2, done: 0, status: "todo" });
    expect(projection.edges.filter((edge) => edge.external)).toHaveLength(2);
  });

  it("traverses the full index iteratively even when nearly every ancestor is folded", () => {
    const seeds = Array.from({ length: 1000 }, (_, position) => ({
      id: `ancestor-${position}`, dependsOn: position === 0 ? [] : [`ancestor-${position - 1}`],
    }));
    const index = buildGraphIndex(graph(seeds));
    expect(tracePrerequisites(index, "ancestor-999")).toEqual(new Set(seeds.map((seed) => seed.id)));
    expect(tracePrerequisites(index, "ancestor-0")).toEqual(new Set(["ancestor-0"]));
  });
});
