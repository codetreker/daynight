package config

import (
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	ListenAddress       string        `yaml:"listen_address"`
	PublicOrigin        string        `yaml:"public_origin"`
	StartupTimeout      time.Duration `yaml:"startup_timeout"`
	ShutdownTimeout     time.Duration `yaml:"shutdown_timeout"`
	AllowHTTPTestOrigin bool          `yaml:"allow_http_test_origin"`
}
type MetricsConfig struct {
	MetricsListenAddress string `yaml:"metrics_listen_address"`
}

func DefaultConfig() Config {
	return Config{ListenAddress: "127.0.0.1:8787", StartupTimeout: 10 * time.Second, ShutdownTimeout: 10 * time.Second}
}
func DefaultMetricsConfig() MetricsConfig { return MetricsConfig{} }
func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(string, string)) error {
	if err := c.ApplyEnvironmentDurations(lookup, mark); err != nil {
		return err
	}
	return c.ApplyEnvironmentRemaining(lookup, mark)
}
func (c *Config) ApplyEnvironmentDurations(lookup func(string) (string, bool), mark func(string, string)) error {
	for _, item := range []struct {
		env, field string
		dst        *time.Duration
	}{{"DAYNIGHT_STARTUP_TIMEOUT", "startup_timeout", &c.StartupTimeout}, {"DAYNIGHT_SHUTDOWN_TIMEOUT", "shutdown_timeout", &c.ShutdownTimeout}} {
		if v, ok := lookup(item.env); ok {
			n, err := configvalue.Duration(v, item.env)
			if err != nil {
				return err
			}
			*item.dst = n
			mark(item.field, item.env)
		}
	}
	return nil
}
func (c *Config) ApplyEnvironmentRemaining(lookup func(string) (string, bool), mark func(string, string)) error {
	for _, item := range []struct {
		env, field string
		dst        *string
	}{{"DAYNIGHT_LISTEN_ADDR", "listen_address", &c.ListenAddress}, {"DAYNIGHT_PUBLIC_ORIGIN", "public_origin", &c.PublicOrigin}} {
		if v, ok := lookup(item.env); ok {
			*item.dst = v
			mark(item.field, item.env)
		}
	}
	if v, ok := lookup("DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN"); ok {
		b, err := configvalue.Flag(v, "DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN")
		if err != nil {
			return err
		}
		c.AllowHTTPTestOrigin = b
		mark("allow_http_test_origin", "DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN")
	}
	return nil
}
func (c *MetricsConfig) ApplyEnvironment(lookup func(string) (string, bool), mark func(string, string)) error {
	if v, ok := lookup("DAYNIGHT_METRICS_LISTEN_ADDR"); ok {
		c.MetricsListenAddress = v
		mark("metrics_listen_address", "DAYNIGHT_METRICS_LISTEN_ADDR")
	}
	return nil
}
func (c Config) ValidateRequired() error {
	if strings.TrimSpace(c.PublicOrigin) == "" {
		return &configvalue.ConfigurationError{Field: "DAYNIGHT_PUBLIC_ORIGIN", Rule: "is required"}
	}
	return nil
}
func (c Config) Validate() error {
	if err := c.ValidateRequired(); err != nil {
		return err
	}
	if _, err := listenerPort(c.ListenAddress); err != nil {
		return err
	}
	return c.ValidateTimeouts()
}
func (c Config) ValidateTimeouts() error {
	if c.StartupTimeout <= 0 || c.ShutdownTimeout <= 0 || c.ShutdownTimeout > 10*time.Second {
		return &configvalue.ConfigurationError{Field: "timeouts", Rule: "startup and shutdown must be positive and shutdown must not exceed 10 seconds"}
	}
	return nil
}
func listenerPort(value string) (int, error) {
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return 0, &configvalue.ConfigurationError{Field: "DAYNIGHT_LISTEN_ADDR", Rule: "must contain a numeric loopback IP and port"}
	}
	addr, err := netip.ParseAddr(host)
	if err != nil || !addr.IsLoopback() || addr.Zone() != "" {
		return 0, &configvalue.ConfigurationError{Field: "DAYNIGHT_LISTEN_ADDR", Rule: "must use a numeric loopback IP"}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 || strconv.Itoa(n) != port {
		return 0, &configvalue.ConfigurationError{Field: "DAYNIGHT_LISTEN_ADDR", Rule: "must use a port from 0 to 65535"}
	}
	return n, nil
}
func (c MetricsConfig) Validate() error { _, err := metricsPort(c.MetricsListenAddress); return err }
func metricsPort(value string) (int, error) {
	if value == "" {
		return 0, nil
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return 0, &configvalue.ConfigurationError{Field: "DAYNIGHT_METRICS_LISTEN_ADDR", Rule: "must contain a numeric IP and port"}
	}
	addr, err := netip.ParseAddr(host)
	if err != nil || addr.Zone() != "" {
		return 0, &configvalue.ConfigurationError{Field: "DAYNIGHT_METRICS_LISTEN_ADDR", Rule: "must use a numeric IP without a scope"}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 || strconv.Itoa(n) != port {
		return 0, &configvalue.ConfigurationError{Field: "DAYNIGHT_METRICS_LISTEN_ADDR", Rule: "must use a port from 0 to 65535"}
	}
	return n, nil
}
func ValidateListeners(server Config, metrics MetricsConfig) error {
	n, err := listenerPort(server.ListenAddress)
	if err != nil {
		return err
	}
	m, err := metricsPort(metrics.MetricsListenAddress)
	if err != nil {
		return err
	}
	if m != 0 && m == n {
		return &configvalue.ConfigurationError{Field: "DAYNIGHT_METRICS_LISTEN_ADDR", Rule: "must use a different nonzero port from DAYNIGHT_LISTEN_ADDR"}
	}
	return nil
}
