package config

import (
	"strings"
	"unicode"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	Root string `yaml:"root"`
}

type Patch struct {
	Root *string `yaml:"root"`
}

func (p Patch) ApplyTo(c *Config) error {
	if p.Root != nil {
		c.Root = *p.Root
	}
	return nil
}

func DefaultConfig() Config { return Config{Root: "storage"} }

func (c *Config) ResolvePaths(root string) error {
	if strings.TrimSpace(c.Root) == "" || strings.IndexFunc(c.Root, unicode.IsControl) >= 0 {
		return &configvalue.ConfigurationError{Field: "root", Rule: "must be nonempty and contain no control characters"}
	}
	c.Root = configvalue.ResolvePath(root, c.Root)
	return nil
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.Root) == "" || strings.IndexFunc(c.Root, unicode.IsControl) >= 0 {
		return &configvalue.ConfigurationError{Field: "root", Rule: "must be nonempty and contain no control characters"}
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
