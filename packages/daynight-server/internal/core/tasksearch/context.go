package tasksearch

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// componentRepresentatives uses disjoint sets so large, dense closures need no
// second copy of their edges. Dependencies point from a prerequisite to a task.
func componentRepresentatives(ctx context.Context, graph store.TaskSearchGraph, seeds []string) (map[string]string, error) {
	n := len(graph.Nodes)
	index := make(map[string]int, n)
	parent := make([]int, n)
	sizes := make([]int, n)
	indegree := make([]int, n)
	for i, node := range graph.Nodes {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		index[node.ID] = i
		parent[i] = i
		sizes[i] = 1
	}
	var find func(int) int
	find = func(x int) int {
		for parent[x] != x {
			parent[x] = parent[parent[x]]
			x = parent[x]
		}
		return x
	}
	for i, edge := range graph.Edges {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		a := index[edge.TaskID]
		b := index[edge.DependsOnID]
		indegree[a]++
		ra, rb := find(a), find(b)
		if ra != rb {
			if sizes[ra] < sizes[rb] {
				ra, rb = rb, ra
			}
			parent[rb] = ra
			sizes[ra] += sizes[rb]
		}
	}
	representatives := make(map[int]int, n)
	for i, node := range graph.Nodes {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if indegree[i] != 0 {
			continue
		}
		root := find(i)
		old, ok := representatives[root]
		if !ok || node.CreatedAt.Before(graph.Nodes[old].CreatedAt) || node.CreatedAt.Equal(graph.Nodes[old].CreatedAt) && node.ID < graph.Nodes[old].ID {
			representatives[root] = i
		}
	}
	result := make(map[string]string, len(seeds))
	for i, id := range seeds {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, ctx.Err()
		}
		i := index[id]
		root := find(i)
		if sizes[root] == 1 {
			result[id] = ""
			continue
		}
		rep := representatives[root]
		result[id] = graph.Nodes[rep].ID
	}
	return result, nil
}
