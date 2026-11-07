package config

import (
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	PublicOrigin         string
	MCPAllowedOrigins    []string
	OAuthClients         map[string][]byte
	MCPTempBudgetBytes   int64
	MCPReservedFreeBytes int64
	UniAuthURL           string
	UniAuthAppID         string
	UniAuthAppSecret     string
	UniAuthCallbackURL   string
	AllowHTTPTestOrigin  bool
	AllowLoopbackHTTP    bool
	DatabaseURL          string
	StorageRoot          string
	ListenAddress        string
	StartupTimeout       time.Duration
	ShutdownTimeout      time.Duration
	TaskSyncOverlap      time.Duration
}

func LoadConfig(getenv func(string) string) (Config, error) {
	clients, err := parseOAuthClients(getenv("DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS"))
	if err != nil {
		return Config{}, err
	}
	tempBudget, err := loadBytes(getenv, "DAYNIGHT_MCP_TEMP_BUDGET_BYTES", 8<<30, false)
	if err != nil {
		return Config{}, err
	}
	reservedFree, err := loadBytes(getenv, "DAYNIGHT_MCP_RESERVED_FREE_BYTES", 1<<30, true)
	if err != nil {
		return Config{}, err
	}
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
		PublicOrigin:         getenv("DAYNIGHT_PUBLIC_ORIGIN"),
		MCPAllowedOrigins:    splitMCPOrigins(getenv("DAYNIGHT_MCP_ALLOWED_ORIGINS")),
		OAuthClients:         clients,
		MCPTempBudgetBytes:   tempBudget,
		MCPReservedFreeBytes: reservedFree,
		UniAuthURL:           getenv("DAYNIGHT_UNIAUTH_URL"),
		UniAuthAppID:         getenv("DAYNIGHT_UNIAUTH_APP_ID"),
		UniAuthAppSecret:     getenv("DAYNIGHT_UNIAUTH_APP_SECRET"),
		UniAuthCallbackURL:   getenv("DAYNIGHT_UNIAUTH_CALLBACK_URL"),
		AllowHTTPTestOrigin:  allowHTTP,
		AllowLoopbackHTTP:    allowLoopback,
		DatabaseURL:          getenv("DAYNIGHT_DATABASE_URL"),
		StorageRoot:          getenv("DAYNIGHT_STORAGE_ROOT"),
		ListenAddress:        address,
		StartupTimeout:       startupTimeout,
		ShutdownTimeout:      shutdownTimeout,
		TaskSyncOverlap:      taskSyncOverlap,
	}
	return config, config.Validate()
}

func loadBytes(getenv func(string) string, field string, fallback int64, allowZero bool) (int64, error) {
	value := getenv(field)
	if value == "" {
		return fallback, nil
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 0 || (!allowZero && n == 0) || strconv.FormatInt(n, 10) != value {
		rule := "must be a nonnegative decimal byte count"
		if !allowZero {
			rule = "must be a positive decimal byte count"
		}
		return 0, &ConfigurationError{Field: field, Rule: rule}
	}
	return n, nil
}

func splitMCPOrigins(value string) []string {
	if value == "" {
		return nil
	}
	values := strings.Split(value, ",")
	for i := range values {
		values[i] = strings.TrimSpace(values[i])
	}
	return values
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
	if err := validateOAuthClients(c.OAuthClients); err != nil {
		return err
	}
	if c.MCPTempBudgetBytes < 0 || c.MCPReservedFreeBytes < 0 {
		return &ConfigurationError{Field: "MCP temporary capacity", Rule: "must not be negative"}
	}
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
	if _, _, err := ValidateAuthSettings(AuthSettings{PublicOrigin: c.PublicOrigin, AllowHTTPTestOrigin: c.AllowHTTPTestOrigin}, c.UniAuthCallbackURL); err != nil {
		return err
	}
	if err := ValidateMCPOrigins(c.MCPAllowedOrigins); err != nil {
		return &ConfigurationError{Field: "DAYNIGHT_MCP_ALLOWED_ORIGINS", Rule: "must contain comma-separated exact origins", Cause: err}
	}
	if err := validateUniAuth(c); err != nil {
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
