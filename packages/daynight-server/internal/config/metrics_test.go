package config

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestMetricsAddress(t *testing.T) {
	for _, value := range []string{"", "127.0.0.1:0", "192.0.2.1:8788", "0.0.0.0:65535", "[::1]:8788", "[::]:0"} {
		t.Run(value, func(t *testing.T) {
			c, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_LISTEN_ADDR": "127.0.0.1:0", "DAYNIGHT_METRICS_LISTEN_ADDR": value}))
			if err != nil || c.Monitoring.Metrics.MetricsListenAddress != value {
				t.Fatalf("metrics address %q: %+v, %v", value, c, err)
			}
		})
	}
	for _, tc := range []struct{ value, rule string }{
		{"127.0.0.1", "must contain a numeric IP and port"},
		{"localhost:1", "must use a numeric IP without a scope"},
		{":1", "must use a numeric IP without a scope"},
		{"[::1%lo]:1", "must use a numeric IP without a scope"},
		{"127.0.0.1:word", "must use a port from 0 to 65535"},
		{"127.0.0.1:-1", "must use a port from 0 to 65535"},
		{"127.0.0.1:65536", "must use a port from 0 to 65535"},
		{"127.0.0.1:080", "must use a port from 0 to 65535"},
		{"127.0.0.1:+1", "must use a port from 0 to 65535"},
		{"0.0.0.0:8787", "must use a different nonzero port from DAYNIGHT_LISTEN_ADDR"},
	} {
		t.Run(tc.value, func(t *testing.T) {
			_, err := LoadConfig(configEnvironment(map[string]string{"DAYNIGHT_METRICS_LISTEN_ADDR": tc.value}))
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_METRICS_LISTEN_ADDR" || failure.Rule != tc.rule || failure.Cause != nil {
				t.Fatalf("metrics address %q: %#v", tc.value, err)
			}
		})
	}
}
