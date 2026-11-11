package config

import (
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	Root string `yaml:"root"`
}

func DefaultConfig() Config { return Config{} }

func (c Config) Validate() error {
	if strings.TrimSpace(c.Root) == "" {
		return &configvalue.ConfigurationError{Field: "DAYNIGHT_STORAGE_ROOT", Rule: "is required"}
	}
	return nil
}

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_STORAGE_ROOT"
	if value, ok := lookup(variable); ok {
		c.Root = value
		if mark != nil {
			mark("root", variable)
		}
	}
	return nil
}
