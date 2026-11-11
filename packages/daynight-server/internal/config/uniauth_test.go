package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestLoadAndValidateRejectUniAuthBeforeListenAddress(t *testing.T) {
	for _, tc := range []struct {
		name, field, value, cause string
	}{
		{"url", "DAYNIGHT_UNIAUTH_URL", "http://remote.example", "BaseURL requires HTTPS"},
		{"app id", "DAYNIGHT_UNIAUTH_APP_ID", "private:app", "App ID requires"},
		{"secret", "DAYNIGHT_UNIAUTH_APP_SECRET", strings.Repeat("s", 513), "App Secret requires"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			values := map[string]string{tc.field: tc.value, "DAYNIGHT_LISTEN_ADDR": "invalid"}
			_, loadErr := LoadConfig(configEnvironment(values))
			c := configuredTestConfig()
			c.Server.ListenAddress = "invalid"
			switch tc.field {
			case "DAYNIGHT_UNIAUTH_URL":
				c.UniAuth.URL = tc.value
			case "DAYNIGHT_UNIAUTH_APP_ID":
				c.UniAuth.AppID = tc.value
			case "DAYNIGHT_UNIAUTH_APP_SECRET":
				c.UniAuth.AppSecret = tc.value
			}
			for _, err := range []error{loadErr, c.Validate()} {
				var failure *configvalue.ConfigurationError
				if !errors.As(err, &failure) || !strings.Contains(failure.Field, testRelativeField(tc.field)) || failure.Cause == nil || !strings.Contains(failure.Cause.Error(), tc.cause) {
					t.Fatalf("expected UniAuth error before listen address: %v", err)
				}
				if strings.Contains(err.Error(), tc.value) || strings.Contains(failure.Cause.Error(), tc.value) {
					t.Fatal("diagnostic exposed configuration value")
				}
			}
		})
	}
}
