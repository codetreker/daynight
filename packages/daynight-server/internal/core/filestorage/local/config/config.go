package config

import (
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	Backend                        string      `yaml:"backend"`
	Azure                          AzureConfig `yaml:"azure"`
	backendSet                     bool
	Root                           string `yaml:"root"`
	ArchiveStagingTopologyVerified bool   `yaml:"archive_staging_topology_verified"`
	ArchiveUploadV2Enabled         bool   `yaml:"archive_upload_v2_enabled"`
}

type AzureConfig struct {
	Endpoint                string `yaml:"endpoint"`
	Container               string `yaml:"container"`
	ManagedIdentityClientID string `yaml:"managed_identity_client_id"`
	ConnectionString        string `yaml:"connection_string"`
}

type AzurePatch struct {
	Endpoint                *string `yaml:"endpoint"`
	Container               *string `yaml:"container"`
	ManagedIdentityClientID *string `yaml:"managed_identity_client_id"`
	ConnectionString        *string `yaml:"connection_string"`
}

type Patch struct {
	Backend                        *string    `yaml:"backend"`
	Azure                          AzurePatch `yaml:"azure"`
	Root                           *string    `yaml:"root"`
	ArchiveStagingTopologyVerified *bool      `yaml:"archive_staging_topology_verified"`
	ArchiveUploadV2Enabled         *bool      `yaml:"archive_upload_v2_enabled"`
}

func (p Patch) ApplyTo(c *Config) error {
	if p.Backend != nil {
		c.Backend = *p.Backend
		c.backendSet = true
	}
	for _, entry := range []struct {
		value  *string
		target *string
	}{
		{p.Azure.Endpoint, &c.Azure.Endpoint}, {p.Azure.Container, &c.Azure.Container},
		{p.Azure.ManagedIdentityClientID, &c.Azure.ManagedIdentityClientID}, {p.Azure.ConnectionString, &c.Azure.ConnectionString},
	} {
		if entry.value != nil {
			*entry.target = *entry.value
		}
	}
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

func DefaultConfig() Config { return Config{Backend: "local", Root: "storage"} }

// BackendName treats a zero-value Config like the historical local default.
func (c Config) BackendName() string {
	if c.Backend == "" {
		return "local"
	}
	return c.Backend
}

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
	if (c.backendSet && c.Backend == "") || (c.BackendName() != "local" && c.BackendName() != "azure-blob") {
		return &configvalue.ConfigurationError{Field: "backend", Rule: "must be local or azure-blob"}
	}
	if c.BackendName() == "azure-blob" {
		if strings.TrimSpace(c.Azure.Container) == "" || strings.TrimSpace(c.Azure.Container) != c.Azure.Container || strings.ContainsAny(c.Azure.Container, "/?#") || strings.IndexFunc(c.Azure.Container, unicode.IsControl) >= 0 {
			return &configvalue.ConfigurationError{Field: "azure.container", Rule: "must identify a container"}
		}
		if c.Azure.ConnectionString != "" {
			if c.Azure.Endpoint != "" || c.Azure.ManagedIdentityClientID != "" {
				return &configvalue.ConfigurationError{Field: "azure", Rule: "connection string and managed identity settings are mutually exclusive"}
			}
		} else {
			u, err := url.Parse(c.Azure.Endpoint)
			if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
				return &configvalue.ConfigurationError{Field: "azure.endpoint", Rule: "must be an HTTPS endpoint without credentials, query or fragment"}
			}
			if strings.TrimSpace(c.Azure.ManagedIdentityClientID) != c.Azure.ManagedIdentityClientID {
				return &configvalue.ConfigurationError{Field: "azure.managed_identity_client_id", Rule: "must not contain surrounding whitespace"}
			}
		}
	}
	if c.BackendName() == "local" && c.ArchiveUploadV2Enabled && !c.ArchiveStagingTopologyVerified {
		return &configvalue.ConfigurationError{Field: "archive_upload_v2_enabled", Rule: "requires a verified archive staging topology"}
	}
	return nil
}

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	for _, setting := range []struct {
		variable, field string
		target          *string
	}{
		{"DAYNIGHT_STORAGE_BACKEND", "backend", &c.Backend},
		{"DAYNIGHT_STORAGE_AZURE_ENDPOINT", "azure.endpoint", &c.Azure.Endpoint},
		{"DAYNIGHT_STORAGE_AZURE_CONTAINER", "azure.container", &c.Azure.Container},
		{"DAYNIGHT_STORAGE_AZURE_MANAGED_IDENTITY_CLIENT_ID", "azure.managed_identity_client_id", &c.Azure.ManagedIdentityClientID},
		{"DAYNIGHT_STORAGE_AZURE_CONNECTION_STRING", "azure.connection_string", &c.Azure.ConnectionString},
	} {
		if value, ok := lookup(setting.variable); ok {
			*setting.target = value
			if setting.field == "backend" {
				c.backendSet = true
			}
			if mark != nil {
				mark(setting.field, setting.variable)
			}
		}
	}
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
