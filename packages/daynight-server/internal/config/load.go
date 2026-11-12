package config

import (
	"bytes"
	"errors"
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/session/imageconfig"
	databaseconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/config"
	redisconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis/config"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	serverconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/config"
	mcpconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp/config"
	applicationconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/application/config"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"
	transferconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer/config"
	oauthconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth/config"
	webhookconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"go.yaml.in/yaml/v4"
	"io"
	"os"
	"strings"
)

type monitoringPatch struct {
	Redis   redisconfig.Patch         `yaml:",inline"`
	Metrics serverconfig.MetricsPatch `yaml:",inline"`
}
type mcpPatch struct {
	Origins  mcpconfig.Patch      `yaml:",inline"`
	Transfer transferconfig.Patch `yaml:",inline"`
}
type patch struct {
	S2S          s2sPatch                        `yaml:"s2s"`
	Server       serverconfig.Patch              `yaml:"server"`
	Database     databaseconfig.Patch            `yaml:"database"`
	Storage      storageconfig.Patch             `yaml:"storage"`
	Monitoring   monitoringPatch                 `yaml:"monitoring"`
	UniAuth      identityconfig.Patch            `yaml:"uniauth"`
	MCP          mcpPatch                        `yaml:"mcp"`
	OAuth        oauthconfig.Patch               `yaml:"oauth"`
	Webhook      webhookconfig.Patch             `yaml:"webhook"`
	TaskSync     applicationconfig.TaskSyncPatch `yaml:"task_sync"`
	ImageDecoder imageconfig.Patch               `yaml:"image_decoder"`
}
type StorageVerificationConfig struct {
	Database            databaseconfig.Config
	Storage             storageconfig.Config
	LocalOverrideLoaded bool
}
type layer struct {
	patch   patch
	origins map[string]configvalue.Origin
	loaded  bool
}

func readLayer(root, name string) (layer, error) {
	var result layer
	path := configvalue.ResolvePath(root, "config/"+name)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if _, e := os.Lstat(path); errors.Is(e, os.ErrNotExist) {
				return result, nil
			}
		}
		return result, &configvalue.ConfigurationError{Phase: "read", Rule: "cannot read configuration file", Origin: configvalue.Origin{Source: name}, Cause: err}
	}
	result.loaded = true
	// Recognize an empty stream before using the strict single-document API.
	loader, err := yaml.NewLoader(bytes.NewReader(data), yaml.WithUniqueKeys())
	if err != nil {
		return result, &configvalue.ConfigurationError{Phase: "decode", Rule: "cannot decode configuration file", Origin: configvalue.Origin{Source: name}, Cause: err}
	}
	var probe yaml.Node
	err = loader.Load(&probe)
	if errors.Is(err, io.EOF) {
		return result, nil
	}
	if err != nil {
		return result, &configvalue.ConfigurationError{Phase: "decode", Rule: "cannot decode configuration file", Origin: configvalue.Origin{Source: name}, Cause: err}
	}
	var doc yaml.Node
	if err = yaml.Load(data, &doc, yaml.WithUniqueKeys()); err != nil {
		return result, &configvalue.ConfigurationError{Phase: "decode", Rule: "cannot decode configuration file", Origin: configvalue.Origin{Source: name}, Cause: err}
	}
	if err = configvalue.CheckDuplicates(&doc); err != nil {
		return result, decorate(err, "", "decode", nil, configvalue.Origin{Source: name})
	}
	if len(doc.Content) != 1 {
		return result, &configvalue.ConfigurationError{Phase: "decode", Rule: "must contain a mapping", Origin: configvalue.Origin{Source: name}}
	}
	result.origins, err = configvalue.Validate(doc.Content[0], patch{}, name)
	if err != nil {
		return result, decorate(err, "", "decode", nil, configvalue.Origin{Source: name})
	}
	if err = doc.Content[0].Load(&result.patch, yaml.WithUniqueKeys()); err != nil {
		return result, &configvalue.ConfigurationError{Phase: "decode", Rule: "cannot construct configuration file", Origin: configvalue.Origin{Source: name}, Cause: err}
	}
	return result, nil
}
func decorate(err error, prefix, phase string, origins map[string]configvalue.Origin, fallback configvalue.Origin) error {
	var failure *configvalue.ConfigurationError
	if !errors.As(err, &failure) {
		return &configvalue.ConfigurationError{Field: prefix, Phase: phase, Rule: "is invalid", Origin: fallback, Cause: err}
	}
	f := *failure
	if prefix != "" {
		if f.Field != "" {
			f.Field = prefix + "." + f.Field
		} else {
			f.Field = prefix
		}
	}
	f.Phase = phase
	if f.Origin.Source == "" {
		if origin, ok := origins[f.Field]; ok {
			f.Origin = origin
		} else {
			fallback.Line = f.Origin.Line
			fallback.Column = f.Origin.Column
			f.Origin = fallback
		}
	}
	if f.Origin.Source == "" {
		f.Origin.Source = "defaults"
	}
	return &f
}
func readLayers(root string) ([]layer, error) {
	layers := make([]layer, 0, 2)
	for _, name := range []string{"config.yml", "config.local.yml"} {
		l, err := readLayer(root, name)
		if err != nil {
			return nil, err
		}
		layers = append(layers, l)
	}
	return layers, nil
}
func LoadServer(root string, lookup func(string) (string, bool)) (Config, error) {
	c := DefaultConfig()
	origins := map[string]configvalue.Origin{}
	layers, err := readLayers(root)
	if err != nil {
		return Config{}, err
	}
	for _, l := range layers {
		for f, o := range l.origins {
			origins[f] = o
		}
		p := l.patch
		for _, item := range []struct {
			group string
			apply func() error
		}{
			{"s2s", func() error { return p.S2S.ApplyTo(&c.S2S) }}, {"server", func() error { return p.Server.ApplyTo(&c.Server) }}, {"database", func() error { return p.Database.ApplyTo(&c.Database) }}, {"storage", func() error { return p.Storage.ApplyTo(&c.Storage) }},
			{"monitoring", func() error { return p.Monitoring.Redis.ApplyTo(&c.Monitoring.Redis) }}, {"monitoring", func() error { return p.Monitoring.Metrics.ApplyTo(&c.Monitoring.Metrics) }},
			{"uniauth", func() error { return p.UniAuth.ApplyTo(&c.UniAuth) }}, {"mcp", func() error { return p.MCP.Origins.ApplyTo(&c.MCP.Origins) }}, {"mcp", func() error { return p.MCP.Transfer.ApplyTo(&c.MCP.Transfer) }},
			{"oauth", func() error { return p.OAuth.ApplyTo(&c.OAuth) }}, {"webhook", func() error { return p.Webhook.ApplyTo(&c.Webhook) }}, {"task_sync", func() error { return p.TaskSync.ApplyTo(&c.TaskSync) }}, {"image_decoder", func() error { return p.ImageDecoder.ApplyTo(&c.ImageDecoder) }},
		} {
			if err = item.apply(); err != nil {
				return Config{}, decorate(err, item.group, "decode", origins, configvalue.Origin{})
			}
		}
	}
	c.LocalOverrideLoaded = layers[1].loaded
	for _, item := range []struct {
		group string
		apply func(func(string) (string, bool), func(string, string)) error
	}{
		{"s2s", c.S2S.ApplyEnvironment}, {"server", c.Server.ApplyEnvironment}, {"database", c.Database.ApplyEnvironment}, {"storage", c.Storage.ApplyEnvironment}, {"monitoring", c.Monitoring.Redis.ApplyEnvironment}, {"monitoring", c.Monitoring.Metrics.ApplyEnvironment}, {"uniauth", c.UniAuth.ApplyEnvironment}, {"mcp", c.MCP.Origins.ApplyEnvironment}, {"mcp", c.MCP.Transfer.ApplyEnvironment}, {"oauth", c.OAuth.ApplyEnvironment}, {"webhook", c.Webhook.ApplyEnvironment}, {"task_sync", c.TaskSync.ApplyEnvironment}, {"image_decoder", c.ImageDecoder.ApplyEnvironment},
	} {
		mark := func(field, variable string) {
			origins[item.group+"."+field] = configvalue.Origin{Source: "environment", EnvName: variable}
		}
		if err = item.apply(lookup, mark); err != nil {
			return Config{}, decorate(err, item.group, "override", origins, configvalue.Origin{Source: "environment"})
		}
	}
	for _, item := range []struct {
		group string
		apply func(string) error
	}{{"storage", c.Storage.ResolvePaths}, {"image_decoder", c.ImageDecoder.ResolvePaths}} {
		if err = item.apply(root); err != nil {
			return Config{}, decorate(err, item.group, "validate", origins, configvalue.Origin{})
		}
	}
	for _, item := range []struct {
		group    string
		validate func() error
	}{
		{"s2s", func() error { return c.S2S.Validate(c.Server.AllowHTTPTestOrigin) }}, {"oauth", c.OAuth.Validate}, {"mcp", c.MCP.Transfer.Validate}, {"database", c.Database.Validate}, {"monitoring", c.Monitoring.Redis.Validate}, {"storage", c.Storage.Validate}, {"server", c.Server.ValidateRequired}, {"uniauth", c.UniAuth.ValidateRequired},
	} {
		if err = item.validate(); err != nil {
			return Config{}, decorate(err, item.group, "validate", origins, configvalue.Origin{})
		}
	}
	if _, _, err = authconfig.ValidateAuthSettings(authconfig.AuthSettings{PublicOrigin: c.Server.PublicOrigin, AllowHTTPTestOrigin: c.Server.AllowHTTPTestOrigin}, c.UniAuth.CallbackURL); err != nil {
		var f *configvalue.ConfigurationError
		group := "server"
		if errors.As(err, &f) && strings.Contains(f.Field, "CALLBACK") {
			group = "uniauth"
			fcopy := *f
			fcopy.Field = "callback_url"
			err = &fcopy
		} else if errors.As(err, &f) {
			fcopy := *f
			fcopy.Field = "public_origin"
			err = &fcopy
		}
		return Config{}, decorate(err, group, "validate", origins, configvalue.Origin{})
	}
	for _, item := range []struct {
		group    string
		validate func() error
	}{
		{"mcp", c.MCP.Origins.Validate}, {"uniauth", c.UniAuth.ValidateCredentials},
	} {
		if err = item.validate(); err != nil {
			return Config{}, decorate(err, item.group, "validate", origins, configvalue.Origin{})
		}
	}
	if err = serverconfig.ValidateListeners(c.Server, c.Monitoring.Metrics); err != nil {
		var f *configvalue.ConfigurationError
		group := "server"
		if errors.As(err, &f) && strings.Contains(strings.ToLower(f.Field), "metrics") {
			group = "monitoring"
		}
		return Config{}, decorate(err, group, "validate", origins, configvalue.Origin{})
	}
	for _, item := range []struct {
		group    string
		validate func() error
	}{
		{"server", c.Server.ValidateTimeouts}, {"task_sync", c.TaskSync.Validate}, {"image_decoder", c.ImageDecoder.Validate},
	} {
		if err = item.validate(); err != nil {
			return Config{}, decorate(err, item.group, "validate", origins, configvalue.Origin{})
		}
	}
	return c, nil
}
func LoadStorageVerification(root string, lookup func(string) (string, bool)) (StorageVerificationConfig, error) {
	c := StorageVerificationConfig{Database: databaseconfig.DefaultConfig(), Storage: storageconfig.DefaultConfig()}
	origins := map[string]configvalue.Origin{}
	layers, err := readLayers(root)
	if err != nil {
		return StorageVerificationConfig{}, err
	}
	for _, l := range layers {
		for f, o := range l.origins {
			origins[f] = o
		}
		for _, item := range []struct {
			group string
			apply func() error
		}{{"database", func() error { return l.patch.Database.ApplyTo(&c.Database) }}, {"storage", func() error { return l.patch.Storage.ApplyTo(&c.Storage) }}} {
			if err = item.apply(); err != nil {
				return StorageVerificationConfig{}, decorate(err, item.group, "decode", origins, configvalue.Origin{})
			}
		}
	}
	c.LocalOverrideLoaded = layers[1].loaded
	for _, item := range []struct {
		group string
		apply func(func(string) (string, bool), func(string, string)) error
	}{{"database", c.Database.ApplyEnvironment}, {"storage", c.Storage.ApplyEnvironment}} {
		mark := func(field, variable string) {
			origins[item.group+"."+field] = configvalue.Origin{Source: "environment", EnvName: variable}
		}
		if err = item.apply(lookup, mark); err != nil {
			return StorageVerificationConfig{}, decorate(err, item.group, "override", origins, configvalue.Origin{Source: "environment"})
		}
	}
	if err = c.Storage.ResolvePaths(root); err != nil {
		return StorageVerificationConfig{}, decorate(err, "storage", "validate", origins, configvalue.Origin{})
	}
	for _, item := range []struct {
		group    string
		validate func() error
	}{{"database", c.Database.Validate}, {"storage", c.Storage.Validate}} {
		if err = item.validate(); err != nil {
			return StorageVerificationConfig{}, decorate(err, item.group, "validate", origins, configvalue.Origin{})
		}
	}
	return c, nil
}
