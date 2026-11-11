package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func verifyStorageCommand(ctx context.Context, root string, lookup func(string) (string, bool), stderr io.Writer, logger *slog.Logger) int {
	cfg, err := config.LoadStorageVerification(root, lookup)
	if err != nil {
		phase := "validate"
		var configErr *configvalue.ConfigurationError
		if errors.As(err, &configErr) && configErr.Phase != "" {
			phase = configErr.Phase
		}
		httpx.LogFailure(logger, ctx, "configuration", phase, err)
		return 1
	}
	logger.InfoContext(ctx, "configuration_loaded", "event", "configuration_loaded", "component", "configuration", "local_override_loaded", cfg.LocalOverrideLoaded)
	ctx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := service.VerifyStorageBackup(ctx, cfg.Database.URL, cfg.Storage.Root); err != nil {
		httpx.LogFailure(logger, ctx, "storage-backup", "verify", err)
		return 1
	}
	fmt.Fprintln(stderr, "Storage backup closure verified.")
	return 0
}
