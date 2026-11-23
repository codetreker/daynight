// Package archiveconfig defines the startup limits for Session archive admission.
package archiveconfig

import (
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	MaxConcurrent         int `yaml:"archive_max_concurrent"`
	MaxConcurrentPerOwner int `yaml:"archive_max_concurrent_per_owner"`
}

type Patch struct {
	MaxConcurrent         *int `yaml:"archive_max_concurrent"`
	MaxConcurrentPerOwner *int `yaml:"archive_max_concurrent_per_owner"`
}

func DefaultConfig() Config { return Config{MaxConcurrent: 20, MaxConcurrentPerOwner: 5} }

func (p Patch) ApplyTo(c *Config) error {
	if p.MaxConcurrent != nil {
		c.MaxConcurrent = *p.MaxConcurrent
	}
	if p.MaxConcurrentPerOwner != nil {
		c.MaxConcurrentPerOwner = *p.MaxConcurrentPerOwner
	}
	return nil
}

func (c Config) Validate() error {
	for _, v := range []struct {
		field string
		value int
	}{
		{"archive_max_concurrent", c.MaxConcurrent},
		{"archive_max_concurrent_per_owner", c.MaxConcurrentPerOwner},
	} {
		if v.value <= 0 {
			return &configvalue.ConfigurationError{Field: v.field, Rule: "must be a positive integer"}
		}
	}
	return nil
}

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(string, string)) error {
	for _, item := range []struct {
		field, variable string
		target          *int
	}{
		{"archive_max_concurrent", "DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT", &c.MaxConcurrent},
		{"archive_max_concurrent_per_owner", "DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT_PER_OWNER", &c.MaxConcurrentPerOwner},
	} {
		if value, ok := lookup(item.variable); ok {
			if mark != nil {
				mark(item.field, item.variable)
			}
			n, err := strconv.Atoi(value)
			if err != nil || n <= 0 || strconv.Itoa(n) != value {
				return &configvalue.ConfigurationError{Field: item.field, Rule: "must be a positive decimal integer"}
			}
			*item.target = n
		}
	}
	return nil
}
