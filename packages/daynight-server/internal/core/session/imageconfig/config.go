package imageconfig

import (
	"path/filepath"
	"strings"
	"unicode"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	NodePath           string `yaml:"node_path"`
	HelperPath         string `yaml:"helper_path"`
	ManifestPath       string `yaml:"manifest_path"`
	TemporaryDirectory string `yaml:"temporary_directory"`
}

type Patch struct {
	NodePath           *string `yaml:"node_path"`
	HelperPath         *string `yaml:"helper_path"`
	ManifestPath       *string `yaml:"manifest_path"`
	TemporaryDirectory *string `yaml:"temporary_directory"`
}

func (p Patch) ApplyTo(c *Config) error {
	if p.NodePath != nil {
		c.NodePath = *p.NodePath
	}
	if p.HelperPath != nil {
		c.HelperPath = *p.HelperPath
	}
	if p.ManifestPath != nil {
		c.ManifestPath = *p.ManifestPath
	}
	if p.TemporaryDirectory != nil {
		c.TemporaryDirectory = *p.TemporaryDirectory
	}
	return nil
}

func (c *Config) ResolvePaths(root string) error {
	c.NodePath = configvalue.ResolvePath(root, c.NodePath)
	c.HelperPath = configvalue.ResolvePath(root, c.HelperPath)
	c.ManifestPath = configvalue.ResolvePath(root, c.ManifestPath)
	c.TemporaryDirectory = configvalue.ResolvePath(root, c.TemporaryDirectory)
	return nil
}

func DefaultConfig() Config { return Config{} }

func (c Config) Validate() error {
	if c.NodePath == "" && c.HelperPath == "" && c.ManifestPath == "" && c.TemporaryDirectory == "" {
		return nil
	}
	for _, item := range []struct{ field, path string }{
		{"node_path", c.NodePath},
		{"helper_path", c.HelperPath},
		{"manifest_path", c.ManifestPath},
		{"temporary_directory", c.TemporaryDirectory},
	} {
		if !filepath.IsAbs(item.path) || filepath.Clean(item.path) != item.path || strings.IndexFunc(item.path, unicode.IsControl) >= 0 {
			return &configvalue.ConfigurationError{Field: item.field, Rule: "must be an absolute clean path in a complete image decoder configuration"}
		}
	}
	return nil
}

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	for _, item := range []struct {
		field, variable string
		target          *string
	}{
		{"node_path", "DAYNIGHT_IMAGE_NODE_PATH", &c.NodePath},
		{"helper_path", "DAYNIGHT_IMAGE_HELPER_PATH", &c.HelperPath},
		{"manifest_path", "DAYNIGHT_IMAGE_MANIFEST_PATH", &c.ManifestPath},
		{"temporary_directory", "DAYNIGHT_IMAGE_TEMP_DIRECTORY", &c.TemporaryDirectory},
	} {
		if value, ok := lookup(item.variable); ok {
			*item.target = value
			if mark != nil {
				mark(item.field, item.variable)
			}
		}
	}
	return nil
}
