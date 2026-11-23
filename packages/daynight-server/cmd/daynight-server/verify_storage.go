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
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
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
	if _, err := fmt.Fprintln(stderr, "Recovery offsets are usable only when verification exits successfully (status 0)."); err != nil {
		return 1
	}
	if err := service.VerifyStorageBackupWithReport(ctx, cfg.Database.URL, cfg.Storage.Root, func(offset sessioncore.ArchiveRecoveryOffset) error {
		_, err := fmt.Fprintf(stderr, "Session %s file %s recovery offset %d\n", offset.SessionID, offset.FileID, offset.Offset)
		return err
	}); err != nil {
		httpx.LogFailure(logger, ctx, "storage-backup", "verify", err)
		return 1
	}
	fmt.Fprintln(stderr, "Storage backup closure verified.")
	return 0
}
