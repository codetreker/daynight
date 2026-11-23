package graph

import "testing"

func TestDisjointSets(t *testing.T) {
	d := NewDisjointSets(6)
	d.Union(0, 1)
	d.Union(2, 3)
	d.Union(3, 0)
	d.Union(1, 2)
	for _, i := range []int{0, 1, 2, 3} {
		if d.Find(i) != d.Find(0) || d.Size(i) != 4 {
			t.Fatalf("vertex %d: root %d size %d", i, d.Find(i), d.Size(i))
		}
	}
	if d.Find(4) == d.Find(0) || d.Find(4) == d.Find(5) || d.Size(4) != 1 {
		t.Fatal("singleton sets merged")
	}
}
