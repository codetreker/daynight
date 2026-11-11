package config

import (
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	AllowedOrigins []string `yaml:"allowed_origins"`
}

type Patch struct {
	AllowedOrigins *[]string `yaml:"allowed_origins"`
}

func (p Patch) ApplyTo(c *Config) error {
	if p.AllowedOrigins != nil {
		c.AllowedOrigins = *p.AllowedOrigins
	}
	return nil
}

func DefaultConfig() Config { return Config{} }

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_MCP_ALLOWED_ORIGINS"
	if value, ok := lookup(variable); ok {
		c.AllowedOrigins = nil
		if value != "" {
			c.AllowedOrigins = strings.Split(value, ",")
			for i := range c.AllowedOrigins {
				c.AllowedOrigins[i] = strings.TrimSpace(c.AllowedOrigins[i])
			}
		}
		mark("allowed_origins", variable)
	}
	return nil
}

func (c Config) Validate() error {
	if err := ValidateOrigins(c.AllowedOrigins); err != nil {
		return &configvalue.ConfigurationError{Field: "allowed_origins", Rule: "must contain exact origins", Cause: err}
	}
	return nil
}
