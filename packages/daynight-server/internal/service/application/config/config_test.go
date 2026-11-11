package config

import (
	"testing"
	"time"
)

func TestTaskSyncConfiguration(t *testing.T) {
	c := DefaultConfig()
	if c.Overlap != 10*time.Second || c.Validate() != nil {
		t.Fatalf("invalid default: %+v", c)
	}
	for value, want := range map[string]time.Duration{"250ms": 250 * time.Millisecond, "30s": 30 * time.Second, "1m30s": 90 * time.Second, "1ns": time.Nanosecond} {
		marked := false
		err := c.ApplyEnvironment(func(key string) (string, bool) { return value, key == "DAYNIGHT_TASK_SYNC_OVERLAP" }, func(field, variable string) { marked = field == "overlap" && variable == "DAYNIGHT_TASK_SYNC_OVERLAP" })
		if err != nil || !marked || c.Overlap != want || c.Validate() != nil {
			t.Fatalf("overlap %q: %+v %v", value, c, err)
		}
	}
	previous := c.Overlap
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "ignored", false }, nil); err != nil || c.Overlap != previous {
		t.Fatalf("absent environment changed configuration: %+v %v", c, err)
	}
	for _, invalid := range []string{"0s", "-1s", "garbage"} {
		if err := c.ApplyEnvironment(func(string) (string, bool) { return invalid, true }, nil); err == nil || c.Overlap != previous {
			t.Fatalf("invalid duration %q: %+v %v", invalid, c, err)
		}
	}
	for _, invalid := range []time.Duration{0, -time.Second} {
		c.Overlap = invalid
		if err := c.Validate(); err == nil {
			t.Fatalf("invalid overlap %v accepted", invalid)
		}
	}
}
