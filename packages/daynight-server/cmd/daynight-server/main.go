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
	exit(run(context.Background(), os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	logger := slog.New(slog.NewJSONHandler(stderr, nil))
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if len(args) != 0 {
		return runAttachmentMigration(ctx, args, getenv, stdout, logger)
	}
	cfg, err := config.LoadConfig(getenv)
	if err != nil {
		httpx.LogFailure(logger, ctx, "configuration", "load", err)
		return 1
	}
	startup, cancelStartup := context.WithTimeout(ctx, cfg.StartupTimeout)
	defer cancelStartup()
	app, err := service.OpenApp(startup, cfg)
	if err != nil {
		httpx.LogFailure(logger, ctx, "server", "startup", err)
		return 1
	}
	handler, err := server.New(app, cfg, logger)
	if err == nil {
		runtime, startErr := server.Start(startup, cfg.ListenAddress, cfg.StartupTimeout, cfg.ShutdownTimeout, logger, handler, handler.Shutdown, app.Engine.CancelWork, app.Engine.Stop, app.Close)
		if startErr == nil {
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
	err = errors.Join(err, app.Close(cleanup))
	httpx.LogFailure(logger, ctx, "server", "startup", err)
	return 1

}
