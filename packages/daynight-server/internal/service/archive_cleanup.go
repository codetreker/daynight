package service

import (
	"errors"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

func (a *App) assembleArchiveCleanup(database store.Transactions, files filestorage.Storage, logger *slog.Logger) error {
	db, ok := database.(store.ArchiveCleanupStore)
	if !ok {
		return errors.New("archive cleanup store unavailable")
	}
	a.archiveCleanup = session.NewArchiveCleanupRunner(session.NewArchiveCleanup(db, files), logger)
	return nil
}
