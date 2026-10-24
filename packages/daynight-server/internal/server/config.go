package server

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type Config struct {
	PublicOrigin        string
	UniAuthURL          string
	UniAuthAppID        string
	UniAuthAppSecret    string
	UniAuthCallbackURL  string
	AllowHTTPTestOrigin bool
	AllowLoopbackHTTP   bool
	DatabaseURL         string
	StorageRoot         string
	ListenAddress       string
	StartupTimeout      time.Duration
	ShutdownTimeout     time.Duration
	TaskSyncOverlap     time.Duration
}

type ConfigurationError struct {
	Field string
	Rule  string
	cause error
}

func (e *ConfigurationError) Error() string { return fmt.Sprintf("%s %s", e.Field, e.Rule) }
func (e *ConfigurationError) Unwrap() error { return e.cause }

func LoadConfig(getenv func(string) string) (Config, error) {
	startupTimeout, err := loadDuration(getenv, "DAYNIGHT_STARTUP_TIMEOUT")
	if err != nil {
		return Config{}, err
	}
	shutdownTimeout, err := loadDuration(getenv, "DAYNIGHT_SHUTDOWN_TIMEOUT")
	if err != nil {
		return Config{}, err
	}
	taskSyncOverlap, err := loadDuration(getenv, "DAYNIGHT_TASK_SYNC_OVERLAP")
	if err != nil {
		return Config{}, err
	}
	allowHTTP, err := loadFlag(getenv, "DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN")
	if err != nil {
		return Config{}, err
	}
	allowLoopback, err := loadFlag(getenv, "DAYNIGHT_ALLOW_LOOPBACK_HTTP")
	if err != nil {
		return Config{}, err
	}
	address := getenv("DAYNIGHT_LISTEN_ADDR")
	if address == "" {
		address = "127.0.0.1:8787"
	}
	config := Config{
		PublicOrigin:        getenv("DAYNIGHT_PUBLIC_ORIGIN"),
		UniAuthURL:          getenv("DAYNIGHT_UNIAUTH_URL"),
		UniAuthAppID:        getenv("DAYNIGHT_UNIAUTH_APP_ID"),
		UniAuthAppSecret:    getenv("DAYNIGHT_UNIAUTH_APP_SECRET"),
		UniAuthCallbackURL:  getenv("DAYNIGHT_UNIAUTH_CALLBACK_URL"),
		AllowHTTPTestOrigin: allowHTTP,
		AllowLoopbackHTTP:   allowLoopback,
		DatabaseURL:         getenv("DAYNIGHT_DATABASE_URL"),
		StorageRoot:         getenv("DAYNIGHT_STORAGE_ROOT"),
		ListenAddress:       address,
		StartupTimeout:      startupTimeout,
		ShutdownTimeout:     shutdownTimeout,
		TaskSyncOverlap:     taskSyncOverlap,
	}
	return config, config.Validate()
}

func loadFlag(getenv func(string) string, field string) (bool, error) {
	switch getenv(field) {
	case "", "0":
		return false, nil
	case "1":
		return true, nil
	default:
		return false, &ConfigurationError{Field: field, Rule: "must be 0 or 1"}
	}
}

func (c Config) identityClient() (*uniauth.Client, error) {
	client, err := uniauth.New(uniauth.Config{BaseURL: c.UniAuthURL, AppID: c.UniAuthAppID, AppSecret: c.UniAuthAppSecret, AllowLoopbackHTTP: c.AllowLoopbackHTTP})
	if err != nil {
		return nil, &ConfigurationError{Field: "DAYNIGHT_UNIAUTH_URL / DAYNIGHT_UNIAUTH_APP_ID / DAYNIGHT_UNIAUTH_APP_SECRET", Rule: "must identify a valid UniAuth origin and backend App credentials", cause: err}
	}
	return client, nil
}

func loadDuration(getenv func(string) string, field string) (time.Duration, error) {
	value := getenv(field)
	if value == "" {
		return 10 * time.Second, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return 0, &ConfigurationError{Field: field, Rule: "must be a positive Go duration"}
	}
	return duration, nil
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.DatabaseURL) == "" {
		return &ConfigurationError{Field: "DAYNIGHT_DATABASE_URL", Rule: "is required"}
	}
	if strings.TrimSpace(c.StorageRoot) == "" {
		return &ConfigurationError{Field: "DAYNIGHT_STORAGE_ROOT", Rule: "is required"}
	}
	for _, required := range []struct{ field, value string }{
		{"DAYNIGHT_PUBLIC_ORIGIN", c.PublicOrigin}, {"DAYNIGHT_UNIAUTH_URL", c.UniAuthURL}, {"DAYNIGHT_UNIAUTH_APP_ID", c.UniAuthAppID}, {"DAYNIGHT_UNIAUTH_APP_SECRET", c.UniAuthAppSecret}, {"DAYNIGHT_UNIAUTH_CALLBACK_URL", c.UniAuthCallbackURL},
	} {
		if strings.TrimSpace(required.value) == "" {
			return &ConfigurationError{Field: required.field, Rule: "is required"}
		}
	}
	if _, _, err := validateAuthSettings(AuthConfig{PublicOrigin: c.PublicOrigin, AllowHTTPTestOrigin: c.AllowHTTPTestOrigin}, c.UniAuthCallbackURL); err != nil {
		return err
	}
	if _, err := c.identityClient(); err != nil {
		return err
	}
	host, port, err := net.SplitHostPort(c.ListenAddress)
	if err != nil {
		return &ConfigurationError{Field: "DAYNIGHT_LISTEN_ADDR", Rule: "must contain a numeric loopback IP and port"}
	}
	address, err := netip.ParseAddr(host)
	if err != nil || !address.IsLoopback() || address.Zone() != "" {
		return &ConfigurationError{Field: "DAYNIGHT_LISTEN_ADDR", Rule: "must use a numeric loopback IP"}
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 0 || number > 65535 || strconv.Itoa(number) != port {
		return &ConfigurationError{Field: "DAYNIGHT_LISTEN_ADDR", Rule: "must use a port from 0 to 65535"}
	}
	if c.StartupTimeout <= 0 || c.ShutdownTimeout <= 0 {
		return &ConfigurationError{Field: "timeouts", Rule: "startup and shutdown must be positive"}
	}
	if c.TaskSyncOverlap <= 0 {
		return &ConfigurationError{Field: "DAYNIGHT_TASK_SYNC_OVERLAP", Rule: "must be a positive Go duration"}
	}
	return nil
}
