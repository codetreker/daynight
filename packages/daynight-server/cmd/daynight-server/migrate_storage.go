package main

import (
	"context"
	"encoding/json"
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

func migrateStorageCommand(ctx context.Context, root, sourceRoot string, lookup func(string) (string, bool), stderr io.Writer, logger *slog.Logger) int {
	cfg, err := config.LoadStorageVerification(root, lookup)
	if err != nil {
		phase := "validate"
		var failure *configvalue.ConfigurationError
		if errors.As(err, &failure) && failure.Phase != "" {
			phase = failure.Phase
		}
		httpx.LogFailure(logger, ctx, "configuration", phase, err)
		return 1
	}
	if cfg.Storage.BackendName() != "azure-blob" {
		fmt.Fprintln(stderr, "Storage migration requires an explicit Azure target and a restored offline database.")
		return 1
	}
	ctx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if _, err = fmt.Fprintln(stderr, "Keep all writers stopped. Enable Azure only after migration exits successfully (status 0). Preserve the untouched pre-cut database and local volume."); err != nil {
		return 1
	}
	encoder := json.NewEncoder(stderr)
	if err = service.MigrateStorage(ctx, cfg.Database.URL, sourceRoot, cfg.Storage, func(event service.StorageMigrationEvent) error {
		return encoder.Encode(event)
	}); err != nil {
		httpx.LogFailure(logger, ctx, "storage-migration", "migrate", err)
		return 1
	}
	if _, err = fmt.Fprintln(stderr, "Storage migration verified. The offline target is ready for Azure startup."); err != nil {
		return 1
	}
	return 0
}
