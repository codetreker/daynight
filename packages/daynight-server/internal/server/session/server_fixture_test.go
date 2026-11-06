package session_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
)

type sessionApplication interface {
	http.Handler
	Shutdown(context.Context) error
}

func configuredTestConfig() configpkg.Config {
	return configpkg.Config{
		DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0",
		StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second,
		PublicOrigin: "https://daynight.example", UniAuthURL: "https://auth.example",
		UniAuthAppID: "configuration-test", UniAuthAppSecret: "configuration-test",
		UniAuthCallbackURL: "https://daynight.example/api/v1/auth/callback",
	}
}

func testLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }
