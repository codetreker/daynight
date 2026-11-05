package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"syscall"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
)

func runArchiveMigration(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer, logger *slog.Logger) int {
	if len(args) != 1 {
		logArchiveMigrationFailure(ctx, logger, &sessionrelay.ArchiveLayoutMigrationError{Phase: "arguments", Category: "invalid_input", Diagnostic: "Use migrate-session-archive-layout without additional arguments."})
		return 1
	}
	summary, err := sessionrelay.MigrateSessionArchiveLayout(ctx, getenv("DAYNIGHT_DATABASE_URL"), getenv("DAYNIGHT_STORAGE_ROOT"), logger)
	if err != nil {
		logArchiveMigrationFailure(ctx, logger, err)
		return 1
	}
	if err = json.NewEncoder(stdout).Encode(summary); err != nil {
		logArchiveMigrationFailure(ctx, logger, &sessionrelay.ArchiveLayoutMigrationError{Phase: "output", Category: "output", Diagnostic: "Archive migration result could not be written; rerun migration with writers stopped to verify the completed layout.", Cause: err})
		return 1
	}
	return 0
}

func logArchiveMigrationFailure(ctx context.Context, logger *slog.Logger, err error) {
	var failure *sessionrelay.ArchiveLayoutMigrationError
	if !errors.As(err, &failure) {
		failure = &sessionrelay.ArchiveLayoutMigrationError{Phase: "operation", Category: "internal", Diagnostic: "Session archive migration failed.", Cause: err}
	}
	cause := server.ErrorKind(err)
	switch {
	case errors.Is(err, fs.ErrPermission):
		cause = "permission"
	case errors.Is(err, fs.ErrNotExist):
		cause = "missing"
	case errors.Is(err, syscall.EXDEV):
		cause = "cross_device"
	}
	logger.ErrorContext(ctx, "session archive layout migration failed", "component", "session_archive_layout_migration", "phase", failure.Phase, "category", failure.Category, "cause", cause, "diagnostic", failure.Diagnostic, "sessionId", failure.SessionID)
}
