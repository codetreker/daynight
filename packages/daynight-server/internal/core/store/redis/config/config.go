package config

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	RedisURL string `yaml:"redis_url"`
}

func DefaultConfig() Config { return Config{} }

func (c Config) Validate() error {
	if c.RedisURL != "" {
		if err := redis.ValidateURL(c.RedisURL); err != nil {
			return &configvalue.ConfigurationError{Field: "DAYNIGHT_REDIS_URL", Rule: "must be a valid redis or rediss URL", Cause: err}
		}
	}
	return nil
}

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	const variable = "DAYNIGHT_REDIS_URL"
	if value, ok := lookup(variable); ok {
		c.RedisURL = value
		if mark != nil {
			mark("redis_url", variable)
		}
	}
	return nil
}
