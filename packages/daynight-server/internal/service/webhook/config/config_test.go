package config

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestWebhookEnvironment(t *testing.T) {
	c := DefaultConfig()
	if c.Enabled || c.Validate() != nil {
		t.Fatal("webhook should default disabled")
	}
	mark := ""
	apply := func(value string) error {
		return c.ApplyEnvironment(func(string) (string, bool) { return value, true }, func(field, variable string) { mark = field + ":" + variable })
	}
	for _, value := range []string{"true", "yes", "2"} {
		err := apply(value)
		var invalid *configvalue.ConfigurationError
		if !errors.As(err, &invalid) || invalid.Field != "DAYNIGHT_WEBHOOK_ENABLED" {
			t.Fatalf("invalid flag %q: %v", value, err)
		}
	}
	if err := apply("1"); err != nil || !c.Enabled || mark != "enabled:DAYNIGHT_WEBHOOK_ENABLED" {
		t.Fatalf("enabled configuration: %v", err)
	}
}
