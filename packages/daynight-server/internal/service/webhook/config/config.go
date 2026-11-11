package config

import "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

type Config struct {
	Enabled bool `yaml:"enabled"`
}

func DefaultConfig() Config { return Config{} }

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_WEBHOOK_ENABLED"
	if value, ok := lookup(variable); ok {
		flag, err := configvalue.Flag(value, variable)
		if err != nil {
			return err
		}
		c.Enabled = flag
		mark("enabled", variable)
	}
	return nil
}

func (c Config) Validate() error { return nil }
