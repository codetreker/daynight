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
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func runAttachmentMigration(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer, logger *slog.Logger) int {
	action, operationID := "", ""
	switch {
	case len(args) == 2 && args[0] == "migrate-attachment-layout" && args[1] == "plan":
		action = "plan"
	case len(args) == 4 && args[0] == "migrate-attachment-layout" && (args[1] == "apply" || args[1] == "resume") && args[2] == "--operation-id":
		action, operationID = args[1], args[3]
	default:
		logAttachmentMigrationFailure(ctx, logger, &service.AttachmentMigrationError{Phase: "arguments", Category: "invalid_input",
			Diagnostic: "Use migrate-attachment-layout plan, or apply/resume --operation-id <uuid>."})
		return 1
	}
	summary, err := service.MigrateAttachmentLayout(ctx, getenv("DAYNIGHT_DATABASE_URL"), getenv("DAYNIGHT_STORAGE_ROOT"), action, operationID, logger)
	if err != nil {
		logAttachmentMigrationFailure(ctx, logger, err)
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(summary); err != nil {
		logAttachmentMigrationFailure(ctx, logger, &service.AttachmentMigrationError{OperationID: summary.OperationID, Phase: "output", Category: "output",
			Diagnostic: "Migration result could not be written; inspect the recorded operation before retrying.", Cause: err})
		return 1
	}
	return 0
}

func logAttachmentMigrationFailure(ctx context.Context, logger *slog.Logger, err error) {
	var failure *service.AttachmentMigrationError
	if !errors.As(err, &failure) {
		failure = &service.AttachmentMigrationError{Phase: "operation", Category: "internal", Diagnostic: "Attachment migration failed.", Cause: err}
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
	logger.ErrorContext(ctx, "attachment layout migration failed", "component", "attachment_layout_migration", "operationId", failure.OperationID,
		"phase", failure.Phase, "category", failure.Category, "cause", cause, "diagnostic", failure.Diagnostic,
		"projectId", failure.ProjectID, "taskId", failure.TaskID)
}
