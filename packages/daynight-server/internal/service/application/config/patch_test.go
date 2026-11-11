package config

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestTaskSyncPatch(t *testing.T) {
	c := DefaultConfig()
	if err := (TaskSyncPatch{}).ApplyTo(&c); err != nil || c.Overlap != 10*time.Second {
		t.Fatalf("omitted overlap: %+v %v", c, err)
	}
	value := configvalue.DurationString("3s")
	if err := (TaskSyncPatch{Overlap: &value}).ApplyTo(&c); err != nil || c.Overlap != 3*time.Second {
		t.Fatalf("override overlap: %+v %v", c, err)
	}
	value = "bad-secret"
	if err := (TaskSyncPatch{Overlap: &value}).ApplyTo(&c); err == nil {
		t.Fatal("invalid duration accepted")
	}
	value = "0s"
	if err := (TaskSyncPatch{Overlap: &value}).ApplyTo(&c); err != nil || c.Validate() == nil {
		t.Fatalf("zero must reach final validation: %+v %v", c, err)
	}
}
