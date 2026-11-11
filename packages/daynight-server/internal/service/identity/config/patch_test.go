package config

import "testing"

func TestPatchPreservesOmittedAndAppliesEmptyAndFalse(t *testing.T) {
	c := Config{URL: "url", AppID: "app", AppSecret: "secret", CallbackURL: "callback", AllowLoopbackHTTP: true}
	empty, disabled := "", false
	if err := (Patch{AppSecret: &empty, AllowLoopbackHTTP: &disabled}).ApplyTo(&c); err != nil {
		t.Fatal(err)
	}
	if c.URL != "url" || c.AppID != "app" || c.AppSecret != "" || c.CallbackURL != "callback" || c.AllowLoopbackHTTP {
		t.Fatalf("patch result: %+v", c)
	}
}
