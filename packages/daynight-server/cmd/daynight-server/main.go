package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server"
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
	config, err := server.LoadConfig(getenv)
	if err != nil {
		server.LogFailure(logger, ctx, "configuration", "load", err)
		return 1
	}
	runtime, err := server.Start(ctx, config, logger, func(dependencies server.Dependencies) (http.Handler, error) {
		return server.New(dependencies, config, logger)
	})
	if err != nil {
		server.LogFailure(logger, ctx, "server", "startup", err)
		return 1
	}
	if err := runtime.Run(ctx); err != nil {
		server.LogFailure(logger, ctx, "server", "shutdown", err)
		return 1
	}
	return 0
}
