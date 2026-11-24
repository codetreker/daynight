// Package graph provides graph algorithms without domain dependencies.
package graph

// DisjointSets maintains a fixed set of integer-indexed vertices.
// Find and Union use path compression and union by size.
type DisjointSets struct {
	parent []int
	size   []int
}

// NewDisjointSets creates n singleton sets indexed from 0 to n-1.
func NewDisjointSets(n int) *DisjointSets {
	d := &DisjointSets{parent: make([]int, n), size: make([]int, n)}
	for i := range d.parent {
		d.parent[i], d.size[i] = i, 1
	}
	return d
}

// Find returns the current representative of the set containing x.
func (d *DisjointSets) Find(x int) int {
	for d.parent[x] != x {
		d.parent[x] = d.parent[d.parent[x]]
		x = d.parent[x]
	}
	return x
}

// Union joins the sets containing a and b.
func (d *DisjointSets) Union(a, b int) {
	a, b = d.Find(a), d.Find(b)
	if a == b {
		return
	}
	if d.size[a] < d.size[b] {
		a, b = b, a
	}
	d.parent[b] = a
	d.size[a] += d.size[b]
}

// Size returns the number of vertices in x's set.
func (d *DisjointSets) Size(x int) int { return d.size[d.Find(x)] }
