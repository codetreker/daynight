package service

import (
	"context"
	"errors"
	"log/slog"

	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

func (a *App) assembleArchiveCleanup(database store.Transactions, files filestorage.Storage, logger *slog.Logger) error {
	db, ok := database.(store.ArchiveCleanupStore)
	if !ok {
		return errors.New("archive cleanup store unavailable")
	}
	cleanup := session.NewArchiveCleanup(db, files)
	cleanup.SetReleasedUploadRecovery(a.releasedUploadRecovery(db))
	a.archiveCleanup = session.NewArchiveCleanupRunner(cleanup, logger)
	return nil
}

func (a *App) releasedUploadRecovery(db store.ArchiveCleanupStore) func(context.Context, store.ArchiveCleanupTarget) error {
	return func(ctx context.Context, target store.ArchiveCleanupTarget) error {
		return a.Sessions.RecoverReleasedArchiveUploads(ctx, target, func(ctx context.Context, work func(*sessioncore.Operation, store.ArchiveCleanupScope) error) error {
			return a.writeReleasedUploadRecovery(ctx, db, target, work)
		})
	}
}

// writeReleasedUploadRecovery publishes in-memory effects only after the actual
// maintenance transaction reports its outcome.
func (a *App) writeReleasedUploadRecovery(ctx context.Context, db store.ArchiveCleanupStore, target store.ArchiveCleanupTarget, work func(*sessioncore.Operation, store.ArchiveCleanupScope) error) error {
	op, err := a.Engine.BeginOperation()
	if err != nil {
		return err
	}
	completion, err := db.WriteArchiveCleanup(ctx, target, func(scope store.ArchiveCleanupScope) error {
		if e := work(op, scope); e != nil {
			return e
		}
		return filestorage.VerifyGates(ctx)
	})
	op.Finish(completion.Outcome)
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("released upload cleanup did not confirm commit")
	}
	return nil
}
