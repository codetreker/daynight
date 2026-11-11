package config

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestPatchPreservesOmittedAndAppliesExplicitValues(t *testing.T) {
	c := DefaultConfig()
	c.AllowHTTPTestOrigin = true
	empty, disabled := "", false
	duration := configvalue.DurationString("3s")
	if err := (Patch{PublicOrigin: &empty, StartupTimeout: &duration, AllowHTTPTestOrigin: &disabled}).ApplyTo(&c); err != nil {
		t.Fatal(err)
	}
	if c.ListenAddress != "127.0.0.1:8787" || c.PublicOrigin != "" || c.StartupTimeout != 3*time.Second || c.ShutdownTimeout != 10*time.Second || c.AllowHTTPTestOrigin {
		t.Fatalf("patch result: %+v", c)
	}
	bad := configvalue.DurationString("bad-secret")
	if err := (Patch{StartupTimeout: &bad}).ApplyTo(&c); err == nil {
		t.Fatal("invalid duration accepted")
	}
	zero := configvalue.DurationString("0s")
	if err := (Patch{StartupTimeout: &zero}).ApplyTo(&c); err != nil || c.StartupTimeout != 0 {
		t.Fatalf("zero duration should be left to final validation: %+v %v", c, err)
	}
	m := MetricsConfig{MetricsListenAddress: "old"}
	if err := (MetricsPatch{MetricsListenAddress: &empty}).ApplyTo(&m); err != nil || m.MetricsListenAddress != "" {
		t.Fatalf("metrics clear: %+v %v", m, err)
	}
}
