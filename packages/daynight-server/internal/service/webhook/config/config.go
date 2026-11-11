package config

import "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

type Config struct {
	Enabled bool `yaml:"enabled"`
}

type Patch struct {
	Enabled *bool `yaml:"enabled"`
}

func (p Patch) ApplyTo(c *Config) error {
	if p.Enabled != nil {
		c.Enabled = *p.Enabled
	}
	return nil
}

func DefaultConfig() Config { return Config{} }

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_WEBHOOK_ENABLED"
	if value, ok := lookup(variable); ok {
		mark("enabled", variable)
		flag, err := configvalue.Flag(value, "enabled")
		if err != nil {
			return err
		}
		c.Enabled = flag
	}
	return nil
}

func (c Config) Validate() error { return nil }
