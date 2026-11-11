package config

import (
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

// Config holds the UniAuth client settings.
type Config struct {
	URL               string `yaml:"url"`
	AppID             string `yaml:"app_id"`
	AppSecret         string `yaml:"app_secret"`
	CallbackURL       string `yaml:"callback_url"`
	AllowLoopbackHTTP bool   `yaml:"allow_loopback_http"`
}

func DefaultConfig() Config { return Config{} }

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(field, variable string)) error {
	for _, item := range []struct {
		field, env string
		target     *string
	}{
		{"url", "DAYNIGHT_UNIAUTH_URL", &c.URL},
		{"app_id", "DAYNIGHT_UNIAUTH_APP_ID", &c.AppID},
		{"app_secret", "DAYNIGHT_UNIAUTH_APP_SECRET", &c.AppSecret},
		{"callback_url", "DAYNIGHT_UNIAUTH_CALLBACK_URL", &c.CallbackURL},
	} {
		if value, ok := lookup(item.env); ok {
			*item.target = value
			mark(item.field, item.env)
		}
	}
	const variable = "DAYNIGHT_ALLOW_LOOPBACK_HTTP"
	if value, ok := lookup(variable); ok {
		flag, err := configvalue.Flag(value, variable)
		if err != nil {
			return err
		}
		c.AllowLoopbackHTTP = flag
		mark("allow_loopback_http", variable)
	}
	return nil
}

func (c Config) ValidateRequired() error {
	for _, item := range []struct{ field, value string }{
		{"DAYNIGHT_UNIAUTH_URL", c.URL}, {"DAYNIGHT_UNIAUTH_APP_ID", c.AppID},
		{"DAYNIGHT_UNIAUTH_APP_SECRET", c.AppSecret}, {"DAYNIGHT_UNIAUTH_CALLBACK_URL", c.CallbackURL},
	} {
		if strings.TrimSpace(item.value) == "" {
			return &configvalue.ConfigurationError{Field: item.field, Rule: "is required"}
		}
	}
	return nil
}

func (c Config) Validate() error {
	if err := c.ValidateRequired(); err != nil {
		return err
	}
	return c.ValidateCredentials()
}
