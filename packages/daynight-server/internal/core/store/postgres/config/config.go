package config

import (
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	URL string `yaml:"url"`
}

func DefaultConfig() Config { return Config{} }

func (c Config) Validate() error {
	if strings.TrimSpace(c.URL) == "" {
		return &configvalue.ConfigurationError{Field: "DAYNIGHT_DATABASE_URL", Rule: "is required"}
	}
	return nil
}

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_DATABASE_URL"
	if value, ok := lookup(variable); ok {
		c.URL = value
		if mark != nil {
			mark("url", variable)
		}
	}
	return nil
}
