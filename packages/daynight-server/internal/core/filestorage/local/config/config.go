package config

import (
	"strconv"
	"strings"
	"unicode"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	Root                           string `yaml:"root"`
	ArchiveStagingTopologyVerified bool   `yaml:"archive_staging_topology_verified"`
	ArchiveUploadV2Enabled         bool   `yaml:"archive_upload_v2_enabled"`
}

type Patch struct {
	Root                           *string `yaml:"root"`
	ArchiveStagingTopologyVerified *bool   `yaml:"archive_staging_topology_verified"`
	ArchiveUploadV2Enabled         *bool   `yaml:"archive_upload_v2_enabled"`
}

func (p Patch) ApplyTo(c *Config) error {
	if p.Root != nil {
		c.Root = *p.Root
	}
	if p.ArchiveStagingTopologyVerified != nil {
		c.ArchiveStagingTopologyVerified = *p.ArchiveStagingTopologyVerified
	}
	if p.ArchiveUploadV2Enabled != nil {
		c.ArchiveUploadV2Enabled = *p.ArchiveUploadV2Enabled
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
	if c.ArchiveUploadV2Enabled && !c.ArchiveStagingTopologyVerified {
		return &configvalue.ConfigurationError{Field: "archive_upload_v2_enabled", Rule: "requires a verified archive staging topology"}
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
	for _, setting := range []struct {
		variable, field string
		target          *bool
	}{
		{"DAYNIGHT_STORAGE_ARCHIVE_STAGING_TOPOLOGY_VERIFIED", "archive_staging_topology_verified", &c.ArchiveStagingTopologyVerified},
		{"DAYNIGHT_STORAGE_ARCHIVE_UPLOAD_V2_ENABLED", "archive_upload_v2_enabled", &c.ArchiveUploadV2Enabled},
	} {
		if value, ok := lookup(setting.variable); ok {
			parsed, err := strconv.ParseBool(value)
			if err != nil {
				return &configvalue.ConfigurationError{Field: setting.field, Rule: "must be a boolean", Cause: err}
			}
			*setting.target = parsed
			if mark != nil {
				mark(setting.field, setting.variable)
			}
		}
	}
	return nil
}
