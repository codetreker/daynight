package attachment

import (
	"context"
	"log/slog"
	"os"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment/migration"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// MigrateAttachmentLayout requires all HTTP, database, and file writers to be
// stopped. The maintenance lock serializes only other maintenance operations.
func MigrateAttachmentLayout(ctx context.Context, databaseURL, storageRoot, action, operationID string, logger *slog.Logger, open func(context.Context, string) (store.AttachmentMaintenance, error)) (migration.AttachmentMigrationSummary, error) {
	id, err := migration.ValidateRequest(action, operationID)
	if err != nil {
		return migration.AttachmentMigrationSummary{}, err
	}
	failure := func(category, diagnostic string, cause error) error {
		return &migration.AttachmentMigrationError{OperationID: id, Phase: "configuration", Category: category, Diagnostic: diagnostic, Cause: cause}
	}
	if strings.TrimSpace(databaseURL) == "" || strings.TrimSpace(storageRoot) == "" {
		return migration.AttachmentMigrationSummary{}, failure("configuration", "DAYNIGHT_DATABASE_URL and DAYNIGHT_STORAGE_ROOT are required.", nil)
	}
	database, err := open(ctx, databaseURL)
	if err != nil {
		return migration.AttachmentMigrationSummary{}, failure("database", migration.MaintenanceDiagnostic(err), err)
	}
	defer database.Close(context.Background())
	root, err := os.OpenRoot(storageRoot)
	if err != nil {
		return migration.AttachmentMigrationSummary{}, failure("filesystem", "Migration storage root could not be opened.", err)
	}
	defer root.Close()
	return migration.Run(ctx, database, root, action, id, logger)
}
