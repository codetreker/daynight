package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

var exit = os.Exit

func main() {
	exit(run(context.Background(), os.Args[1:], os.Getenv, os.Stderr))
}

func run(ctx context.Context, args []string, getenv func(string) string, stderr io.Writer) int {
	if len(args) == 1 && args[0] == "verify-storage" {
		return verifyStorageCommand(ctx, getenv, stderr)
	}
	logger := slog.New(slog.NewJSONHandler(stderr, nil))
	if len(args) != 0 {
		httpx.LogFailure(logger, ctx, "configuration", "arguments", &config.ConfigurationError{Field: "command-line arguments", Rule: "are not supported"})
		return 1
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := config.LoadConfig(getenv)
	if err != nil {
		httpx.LogFailure(logger, ctx, "configuration", "load", err)
		return 1
	}
	startup, cancelStartup := context.WithTimeout(ctx, cfg.StartupTimeout)
	defer cancelStartup()
	app, err := service.OpenAppWithLogger(startup, cfg, logger)
	if err != nil {
		httpx.LogFailure(logger, ctx, "server", "startup", err)
		return 1
	}
	return serveApp(ctx, startup, cancelStartup, cfg, app, logger)
}

func serveApp(ctx, startup context.Context, cancelStartup context.CancelFunc, cfg config.Config, app *service.App, logger *slog.Logger) int {
	handler, err := server.New(app, cfg, logger)
	if err == nil {
		var metrics []server.MetricsEndpoint
		if cfg.MetricsListenAddress != "" {
			metrics = append(metrics, server.MetricsEndpoint{Address: cfg.MetricsListenAddress, Registry: app.Metrics})
		}
		runtime, startErr := server.Start(startup, cfg.ListenAddress, cfg.StartupTimeout, cfg.ShutdownTimeout, logger, handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close, metrics...)
		if startErr == nil {
			if startErr = app.Start(ctx); startErr != nil {
				cleanup, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
				defer cancel()
				err = errors.Join(startErr, runtime.Close(cleanup))
				httpx.LogFailure(logger, ctx, "server", "startup", err)
				return 1
			}
			cancelStartup()
			if runErr := runtime.Run(ctx); runErr != nil {
				httpx.LogFailure(logger, ctx, "server", "shutdown", runErr)
				return 1
			}
			return 0
		}
		err = startErr
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if handler != nil {
		handler.BeginShutdown()
		err = errors.Join(err, handler.Shutdown(cleanup))
	}
	err = errors.Join(err, app.Close(cleanup))
	httpx.LogFailure(logger, ctx, "server", "startup", err)
	return 1
}
