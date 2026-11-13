package config

import (
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/session/imageconfig"
	databaseconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/config"
	redisconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis/config"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	serverconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/config"
	mcpconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp/config"
	applicationconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/application/config"
	githubconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/github/config"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"
	transferconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer/config"
	oauthconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth/config"
	webhookconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook/config"
)

type MonitoringConfig struct {
	Redis   redisconfig.Config         `yaml:",inline"`
	Metrics serverconfig.MetricsConfig `yaml:",inline"`
}
type MCPConfig struct {
	Origins  mcpconfig.Config      `yaml:",inline"`
	Transfer transferconfig.Config `yaml:",inline"`
}
type Config struct {
	S2S                 S2SConfig                        `yaml:"s2s"`
	LocalOverrideLoaded bool                             `yaml:"-"`
	Server              serverconfig.Config              `yaml:"server"`
	Database            databaseconfig.Config            `yaml:"database"`
	Storage             storageconfig.Config             `yaml:"storage"`
	Monitoring          MonitoringConfig                 `yaml:"monitoring"`
	UniAuth             identityconfig.Config            `yaml:"uniauth"`
	MCP                 MCPConfig                        `yaml:"mcp"`
	OAuth               oauthconfig.Config               `yaml:"oauth"`
	GitHub              githubconfig.Config              `yaml:"github"`
	Webhook             webhookconfig.Config             `yaml:"webhook"`
	TaskSync            applicationconfig.TaskSyncConfig `yaml:"task_sync"`
	ImageDecoder        imageconfig.Config               `yaml:"image_decoder"`
}

func DefaultConfig() Config {
	return Config{
		Server: serverconfig.DefaultConfig(), Database: databaseconfig.DefaultConfig(), Storage: storageconfig.DefaultConfig(),
		Monitoring: MonitoringConfig{Redis: redisconfig.DefaultConfig(), Metrics: serverconfig.DefaultMetricsConfig()},
		UniAuth:    identityconfig.DefaultConfig(), MCP: MCPConfig{Origins: mcpconfig.DefaultConfig(), Transfer: transferconfig.DefaultConfig()},
		GitHub: githubconfig.DefaultConfig(), OAuth: oauthconfig.DefaultConfig(), Webhook: webhookconfig.DefaultConfig(), TaskSync: applicationconfig.DefaultConfig(), ImageDecoder: imageconfig.DefaultConfig(),
	}
}
func LoadConfig(getenv func(string) string) (Config, error) {
	c := DefaultConfig()
	lookup := func(key string) (string, bool) { v := getenv(key); return v, v != "" }
	mark := func(string, string) {}
	for _, apply := range []func(func(string) (string, bool), func(string, string)) error{
		c.S2S.ApplyEnvironment, c.OAuth.ApplyEnvironment, c.MCP.Transfer.ApplyEnvironment, c.Server.ApplyEnvironmentDurations, c.TaskSync.ApplyEnvironment, c.Server.ApplyEnvironmentRemaining, c.UniAuth.ApplyEnvironment, c.GitHub.ApplyEnvironment, c.Webhook.ApplyEnvironment, c.Database.ApplyEnvironment, c.Monitoring.Redis.ApplyEnvironment, c.Storage.ApplyEnvironment, c.MCP.Origins.ApplyEnvironment, c.Monitoring.Metrics.ApplyEnvironment, c.ImageDecoder.ApplyEnvironment,
	} {
		if err := apply(lookup, mark); err != nil {
			return Config{}, err
		}
	}
	return c, c.Validate()
}
func (c Config) Validate() error {
	if err := c.S2S.Validate(c.Server.AllowHTTPTestOrigin); err != nil {
		return err
	}
	for _, validate := range []func() error{c.GitHub.Validate, c.OAuth.Validate, c.MCP.Transfer.Validate, c.Database.Validate, c.Monitoring.Redis.Validate, c.Storage.Validate, c.Server.ValidateRequired, c.UniAuth.ValidateRequired} {
		if err := validate(); err != nil {
			return err
		}
	}
	if _, _, err := authconfig.ValidateAuthSettings(authconfig.AuthSettings{PublicOrigin: c.Server.PublicOrigin, AllowHTTPTestOrigin: c.Server.AllowHTTPTestOrigin}, c.UniAuth.CallbackURL); err != nil {
		return err
	}
	if err := c.MCP.Origins.Validate(); err != nil {
		return err
	}
	if err := c.UniAuth.ValidateCredentials(); err != nil {
		return err
	}
	if err := serverconfig.ValidateListeners(c.Server, c.Monitoring.Metrics); err != nil {
		return err
	}
	for _, validate := range []func() error{c.Server.ValidateTimeouts, c.TaskSync.Validate, c.ImageDecoder.Validate} {
		if err := validate(); err != nil {
			return err
		}
	}
	return nil
}
