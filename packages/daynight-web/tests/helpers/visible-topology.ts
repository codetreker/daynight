export type DependencyTopology = { nodes: readonly { id: string }[]; edges: readonly { id: string; source: string; target: string; external: boolean }[] };


export const inducedTopology = (full: DependencyTopology, nodeIds: readonly string[]): DependencyTopology => {
  const visible = new Set(nodeIds);
  if (visible.size !== nodeIds.length || nodeIds.some((id) => !full.nodes.some((node) => node.id === id))) throw new Error('Visible task identities differ from the complete API projection.');
  return { nodes: full.nodes.filter((node) => visible.has(node.id)), edges: full.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)) };
};

export const expectedNodeHeights = (full: DependencyTopology, nodeIds: readonly string[]): { id: string; height: number }[] => {
  const visible = new Set(nodeIds);
  return inducedTopology(full, nodeIds).nodes.map(({ id }) => ({ id, height: full.edges.some(({ source, target }) =>
    source === id && !visible.has(target) || target === id && !visible.has(source)) ? 136 : 96 }));
};

export const expectedOverview = (full: DependencyTopology, rootId: string, snapshotOrder: readonly string[]): DependencyTopology => {
  if (full.nodes.length <= 50 && full.edges.length <= 100) return full;
  const order = new Map(snapshotOrder.map((id, position) => [id, position]));
  const neighbors = (id: string, downstream: boolean) => full.edges.filter((edge) => downstream ? edge.source === id : edge.target === id)
    .map((edge) => downstream ? edge.target : edge.source).sort((a, b) => order.get(a)! - order.get(b)!);
  const visible = new Set([rootId]); const queue = [rootId];
  for (let position = 0; position < queue.length && visible.size < 50; position++) {
    for (const id of [...neighbors(queue[position]!, true), ...neighbors(queue[position]!, false)]) {
      if (visible.has(id) || visible.size === 50) continue;
      const candidate = [...visible, id];
      if (inducedTopology(full, candidate).edges.length > 100) continue;
      visible.add(id); queue.push(id);
    }
  }
  return inducedTopology(full, [...visible]);
};

export const expectedBatch = (full: DependencyTopology, visibleIds: readonly string[], taskId: string, direction: 'upstream' | 'downstream', snapshotOrder: readonly string[]): DependencyTopology => {
  const visible = new Set(visibleIds); const order = new Map(snapshotOrder.map((id, position) => [id, position]));
  const neighbors = full.edges.filter((edge) => direction === 'downstream' ? edge.source === taskId : edge.target === taskId)
    .map((edge) => direction === 'downstream' ? edge.target : edge.source).filter((id) => !visible.has(id)).sort((a, b) => order.get(a)! - order.get(b)!).slice(0, 20);
  return inducedTopology(full, [...visibleIds, ...neighbors]);
};

export type ChainTopology = DependencyTopology & { readonly memberIds: readonly string[] };

type DependencyTask = { readonly id: string; readonly dependsOn: readonly string[]; readonly externalDependsOn: readonly string[] };

export const expectedChainMembers = (tasks: readonly DependencyTask[], memberId: string): readonly string[] => {
  const parents = new Map(tasks.map(({ id }) => [id, id]));
  const component = (id: string): string => {
    if (!parents.has(id)) throw new Error('Dependency topology references an unknown task.');
    let root = id;
    while (parents.get(root)! !== root) root = parents.get(root)!;
    let current = id;
    while (parents.get(current)! !== root) { const next = parents.get(current)!; parents.set(current, root); current = next; }
    return root;
  };
  for (const task of tasks) {
    if (task.externalDependsOn.some((id) => !task.dependsOn.includes(id))) throw new Error('External dependencies are not a subset of the complete task relations.');
    for (const predecessor of task.dependsOn) if (!task.externalDependsOn.includes(predecessor)) {
      const left = component(task.id); const right = component(predecessor);
      if (left !== right) parents.set(right, left);
    }
  }
  const selected = component(memberId);
  return tasks.filter(({ id }) => component(id) === selected).map(({ id }) => id);
};

export const expectedDependencyTopology = (tasks: readonly DependencyTask[], representativeId: string): ChainTopology => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memberIds = expectedChainMembers(tasks, representativeId);
  const visible = new Set(memberIds); const ancestors = [...visible];
  while (ancestors.length > 0) for (const id of byId.get(ancestors.pop()!)!.dependsOn) {
    if (!byId.has(id)) throw new Error('Dependency topology references an unknown prerequisite.');
    if (!visible.has(id)) { visible.add(id); ancestors.push(id); }
  }
  return {
    memberIds,
    nodes: tasks.filter((task) => visible.has(task.id)).map(({ id }) => ({ id })),
    edges: tasks.filter((task) => visible.has(task.id)).flatMap((task) => task.dependsOn.map((source) => ({
      id: `${source}->${task.id}`, source, target: task.id, external: task.externalDependsOn.includes(source),
    }))),
  };
};
