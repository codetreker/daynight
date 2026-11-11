package config

import "testing"

func TestPatchCanDisableWebhook(t *testing.T) {
	c := Config{Enabled: true}
	if err := (Patch{}).ApplyTo(&c); err != nil || !c.Enabled {
		t.Fatalf("omitted value changed config: %+v %v", c, err)
	}
	disabled := false
	if err := (Patch{Enabled: &disabled}).ApplyTo(&c); err != nil || c.Enabled {
		t.Fatalf("false override: %+v %v", c, err)
	}
}
