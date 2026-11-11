package config

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestDefaultsAndEnvironment(t *testing.T) {
	c, metrics := DefaultConfig(), DefaultMetricsConfig()
	if c.ListenAddress != "127.0.0.1:8787" || c.StartupTimeout != 10*time.Second || c.ShutdownTimeout != 10*time.Second || c.PublicOrigin != "" || c.AllowHTTPTestOrigin || metrics.MetricsListenAddress != "" {
		t.Fatalf("unexpected defaults: %+v %+v", c, metrics)
	}
	values := map[string]string{
		"DAYNIGHT_LISTEN_ADDR": "[::1]:4000", "DAYNIGHT_PUBLIC_ORIGIN": "http://localhost:4000",
		"DAYNIGHT_STARTUP_TIMEOUT": "2s", "DAYNIGHT_SHUTDOWN_TIMEOUT": "300ms",
		"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1", "DAYNIGHT_METRICS_LISTEN_ADDR": "0.0.0.0:4001",
	}
	lookup := func(key string) (string, bool) { value, ok := values[key]; return value, ok }
	marks := map[string]string{}
	mark := func(field, variable string) { marks[field] = variable }
	if err := c.ApplyEnvironment(lookup, mark); err != nil {
		t.Fatal(err)
	}
	if err := metrics.ApplyEnvironment(lookup, mark); err != nil {
		t.Fatal(err)
	}
	if c.ListenAddress != values["DAYNIGHT_LISTEN_ADDR"] || c.PublicOrigin != values["DAYNIGHT_PUBLIC_ORIGIN"] || c.StartupTimeout != 2*time.Second || c.ShutdownTimeout != 300*time.Millisecond || !c.AllowHTTPTestOrigin || metrics.MetricsListenAddress != values["DAYNIGHT_METRICS_LISTEN_ADDR"] {
		t.Fatalf("environment ignored: %+v %+v", c, metrics)
	}
	for field, variable := range map[string]string{"listen_address": "DAYNIGHT_LISTEN_ADDR", "public_origin": "DAYNIGHT_PUBLIC_ORIGIN", "startup_timeout": "DAYNIGHT_STARTUP_TIMEOUT", "shutdown_timeout": "DAYNIGHT_SHUTDOWN_TIMEOUT", "allow_http_test_origin": "DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN", "metrics_listen_address": "DAYNIGHT_METRICS_LISTEN_ADDR"} {
		if marks[field] != variable {
			t.Errorf("missing provenance for %s: %v", field, marks)
		}
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := metrics.Validate(); err != nil {
		t.Fatal(err)
	}
	original, originalMetrics := c, metrics
	absent := func(string) (string, bool) { return "ignored", false }
	if err := c.ApplyEnvironment(absent, mark); err != nil || c != original {
		t.Fatalf("absent environment changed server: %+v %v", c, err)
	}
	if err := metrics.ApplyEnvironment(absent, mark); err != nil || metrics != originalMetrics {
		t.Fatalf("absent environment changed metrics: %+v %v", metrics, err)
	}
	for _, field := range []string{"DAYNIGHT_STARTUP_TIMEOUT", "DAYNIGHT_SHUTDOWN_TIMEOUT", "DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN"} {
		before := c
		err := c.ApplyEnvironment(func(key string) (string, bool) { return "secret-value", key == field }, mark)
		var failure *configvalue.ConfigurationError
		if !errors.As(err, &failure) || failure.Field != field || c != before {
			t.Fatalf("invalid %s was not rejected safely: %+v %v", field, c, err)
		}
	}
}

func TestServerValidation(t *testing.T) {
	c := DefaultConfig()
	for _, value := range []string{"", " \t"} {
		c.PublicOrigin = value
		if err := c.Validate(); err == nil || err.Error() != "DAYNIGHT_PUBLIC_ORIGIN is required" {
			t.Fatalf("origin %q: %v", value, err)
		}
	}
	c.PublicOrigin = "https://example.test"
	for _, address := range []string{"127.0.0.1:0", "127.0.0.1:65535", "[::1]:8787"} {
		c.ListenAddress = address
		if err := c.Validate(); err != nil {
			t.Errorf("valid address %q: %v", address, err)
		}
	}
	for _, address := range []string{"localhost:80", ":80", "0.0.0.0:80", "[::]:80", "192.0.2.1:80", "[::1%eth0]:80", "127.0.0.1", "127.0.0.1:word", "127.0.0.1:-1", "127.0.0.1:65536", "127.0.0.1:080"} {
		c.ListenAddress = address
		var failure *configvalue.ConfigurationError
		if err := c.Validate(); !errors.As(err, &failure) || failure.Field != "DAYNIGHT_LISTEN_ADDR" {
			t.Errorf("invalid address %q: %v", address, err)
		}
	}
	c.ListenAddress = "127.0.0.1:0"
	for _, tc := range []struct {
		startup, shutdown time.Duration
		valid             bool
	}{
		{time.Nanosecond, 10 * time.Second, true}, {0, time.Second, false}, {-time.Second, time.Second, false},
		{time.Second, 0, false}, {time.Second, -time.Second, false}, {time.Second, 10*time.Second + time.Nanosecond, false},
	} {
		c.StartupTimeout, c.ShutdownTimeout = tc.startup, tc.shutdown
		if err := c.Validate(); (err == nil) != tc.valid {
			t.Errorf("timeouts %+v: %v", tc, err)
		}
	}
}

func TestMetricsAndListenerValidation(t *testing.T) {
	server := DefaultConfig()
	for _, value := range []string{"", "127.0.0.1:0", "192.0.2.1:8788", "0.0.0.0:65535", "[::1]:8788", "[::]:0"} {
		metrics := MetricsConfig{MetricsListenAddress: value}
		if err := metrics.Validate(); err != nil {
			t.Errorf("valid metrics %q: %v", value, err)
		}
		if err := ValidateListeners(server, metrics); err != nil {
			t.Errorf("valid listeners %q: %v", value, err)
		}
	}
	for _, tc := range []struct{ value, rule string }{
		{"127.0.0.1", "must contain a numeric IP and port"}, {"localhost:1", "must use a numeric IP without a scope"},
		{":1", "must use a numeric IP without a scope"}, {"[::1%lo]:1", "must use a numeric IP without a scope"},
		{"127.0.0.1:word", "must use a port from 0 to 65535"}, {"127.0.0.1:-1", "must use a port from 0 to 65535"},
		{"127.0.0.1:65536", "must use a port from 0 to 65535"}, {"127.0.0.1:080", "must use a port from 0 to 65535"}, {"127.0.0.1:+1", "must use a port from 0 to 65535"},
	} {
		metrics := MetricsConfig{MetricsListenAddress: tc.value}
		for _, err := range []error{metrics.Validate(), ValidateListeners(server, metrics)} {
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != "DAYNIGHT_METRICS_LISTEN_ADDR" || failure.Rule != tc.rule {
				t.Errorf("invalid metrics %q: %v", tc.value, err)
			}
		}
	}
	var failure *configvalue.ConfigurationError
	if err := ValidateListeners(server, MetricsConfig{MetricsListenAddress: "0.0.0.0:8787"}); !errors.As(err, &failure) || failure.Field != "DAYNIGHT_METRICS_LISTEN_ADDR" || failure.Rule != "must use a different nonzero port from DAYNIGHT_LISTEN_ADDR" {
		t.Errorf("same nonzero port: %v", err)
	}
	server.ListenAddress = "127.0.0.1:0"
	if err := ValidateListeners(server, MetricsConfig{MetricsListenAddress: "127.0.0.1:0"}); err != nil {
		t.Errorf("zero ports may match: %v", err)
	}
	server.ListenAddress = "invalid"
	if err := ValidateListeners(server, MetricsConfig{MetricsListenAddress: "invalid"}); !errors.As(err, &failure) || failure.Field != "DAYNIGHT_LISTEN_ADDR" {
		t.Errorf("server error should precede metrics: %v", err)
	}
}
