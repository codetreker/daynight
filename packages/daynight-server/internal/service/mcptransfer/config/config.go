package config

import "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

type Config struct {
	TempBudgetBytes   int64 `yaml:"temp_budget_bytes"`
	ReservedFreeBytes int64 `yaml:"reserved_free_bytes"`
}

func DefaultConfig() Config { return Config{TempBudgetBytes: 8 << 30, ReservedFreeBytes: 1 << 30} }

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	for _, item := range []struct {
		field, env string
		target     *int64
		allowZero  bool
	}{
		{"temp_budget_bytes", "DAYNIGHT_MCP_TEMP_BUDGET_BYTES", &c.TempBudgetBytes, false},
		{"reserved_free_bytes", "DAYNIGHT_MCP_RESERVED_FREE_BYTES", &c.ReservedFreeBytes, true},
	} {
		if value, ok := lookup(item.env); ok {
			parsed, err := configvalue.Bytes(value, item.env, item.allowZero)
			if err != nil {
				return err
			}
			*item.target = parsed
			mark(item.field, item.env)
		}
	}
	return nil
}

// Manually constructed zero budgets are resolved by application assembly.
func (c Config) Validate() error {
	if c.TempBudgetBytes < 0 || c.ReservedFreeBytes < 0 {
		return &configvalue.ConfigurationError{Field: "MCP temporary capacity", Rule: "must not be negative"}
	}
	return nil
}
