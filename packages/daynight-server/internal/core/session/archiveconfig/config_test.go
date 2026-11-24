package archiveconfig

import "testing"

func TestConfiguration(t *testing.T) {
	c := DefaultConfig()
	if c.MaxConcurrent != 20 || c.MaxConcurrentPerOwner != 5 || c.Validate() != nil {
		t.Fatalf("defaults: %+v", c)
	}
	one, two := 3, 2
	if err := (Patch{MaxConcurrent: &one, MaxConcurrentPerOwner: &two}).ApplyTo(&c); err != nil || c.MaxConcurrent != one || c.MaxConcurrentPerOwner != two {
		t.Fatalf("patch: %+v %v", c, err)
	}
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "", false }, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "9", true }, nil); err != nil || c.MaxConcurrent != 9 || c.MaxConcurrentPerOwner != 9 {
		t.Fatalf("override: %+v %v", c, err)
	}
	c.MaxConcurrent = 0
	if c.Validate() == nil {
		t.Fatal("zero instance limit accepted")
	}
	c.MaxConcurrent, c.MaxConcurrentPerOwner = 1, -1
	if c.Validate() == nil {
		t.Fatal("negative owner limit accepted")
	}
}
