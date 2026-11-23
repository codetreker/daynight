package github

import "testing"

func TestProjectRepositoryAddress(t *testing.T) {
	for _, s := range []string{"https://github.com/o/r.git", "ssh://git@github.com/o/r.git", "git@github.com:o/r.git"} {
		o, r, e := ProjectRepository(s)
		if e != nil || o != "o" || r != "r" {
			t.Fatalf("%s %s %s %v", s, o, r, e)
		}
	}
	for _, s := range []string{"https://example.com/o/r", "https://github.com/o/r/other"} {
		if _, _, e := ProjectRepository(s); e == nil {
			t.Fatalf("accepted %s", s)
		}
	}
}
