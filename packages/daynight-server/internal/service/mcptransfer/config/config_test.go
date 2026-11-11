package config

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestCapacityEnvironmentAndValidation(t *testing.T) {
	c := DefaultConfig()
	if c.TempBudgetBytes != 8<<30 || c.ReservedFreeBytes != 1<<30 {
		t.Fatalf("defaults: %+v", c)
	}
	values := map[string]string{"DAYNIGHT_MCP_TEMP_BUDGET_BYTES": "123", "DAYNIGHT_MCP_RESERVED_FREE_BYTES": "0"}
	lookup := func(key string) (string, bool) { v, ok := values[key]; return v, ok }
	marks := map[string]string{}
	if err := c.ApplyEnvironment(lookup, func(f, v string) { marks[f] = v }); err != nil || c.TempBudgetBytes != 123 || c.ReservedFreeBytes != 0 || marks["temp_budget_bytes"] != "DAYNIGHT_MCP_TEMP_BUDGET_BYTES" || marks["reserved_free_bytes"] != "DAYNIGHT_MCP_RESERVED_FREE_BYTES" {
		t.Fatalf("override: %+v, %v", c, err)
	}
	for _, field := range []string{"DAYNIGHT_MCP_TEMP_BUDGET_BYTES", "DAYNIGHT_MCP_RESERVED_FREE_BYTES"} {
		for _, value := range []string{"-1", "+1", "01", "1GiB", "9223372036854775808"} {
			c = DefaultConfig()
			values = map[string]string{field: value}
			err := c.ApplyEnvironment(lookup, func(string, string) {})
			var failure *configvalue.ConfigurationError
			expected := "temp_budget_bytes"
			if field == "DAYNIGHT_MCP_RESERVED_FREE_BYTES" {
				expected = "reserved_free_bytes"
			}
			if !errors.As(err, &failure) || failure.Field != expected {
				t.Fatalf("accepted %s=%q: %v", field, value, err)
			}
		}
	}
	values = map[string]string{"DAYNIGHT_MCP_TEMP_BUDGET_BYTES": "0"}
	if err := c.ApplyEnvironment(lookup, func(string, string) {}); err == nil {
		t.Fatal("zero environment budget accepted")
	}
	if err := (Config{}).Validate(); err == nil {
		t.Fatal("zero budget accepted")
	}
	if err := (Config{TempBudgetBytes: 1, ReservedFreeBytes: -1}).Validate(); err == nil {
		t.Fatal("negative capacity accepted")
	}
	if err := (Config{TempBudgetBytes: 1, ReservedFreeBytes: 0}).Validate(); err != nil {
		t.Fatalf("zero reserve: %v", err)
	}
}
