package session

import (
	"context"
	"errors"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Terminal cleanup is independent of the durable receipt and is retried by
// later archive changes. Physical exclusion also fences a late former writer.
func (op *ArchiveOperation) cleanupArchiveStreamTerminal(ctx context.Context) (result error) {
	// Avoid opening or creating a staging namespace when there is no pending
	// terminal cleanup, including deployments that have never enabled v2.
	pending := false
	err := op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
		d, ok := dao.(store.SessionArchiveStagingDAO)
		if !ok {
			return nil
		}
		rows, e := d.ArchiveStagingRecords(ctx, op.id)
		if e != nil {
			return e
		}
		for _, row := range rows {
			if !row.StagingReleased && (row.State == "complete" || row.State == "failed") {
				pending = true
				break
			}
		}
		return nil
	})
	if err != nil || !pending {
		return err
	}
	namespace, err := archiveNamespace(op.project, op.owner, op.id)
	if err != nil {
		return err
	}
	backend, ok := op.execution.files.(filestorage.ArchiveStagingBackend)
	if !ok {
		return errors.New("archive staging unavailable")
	}
	handle, err := backend.AcquireArchiveStaging(ctx, namespace, true)
	if err != nil {
		return stagingBusy(err)
	}
	defer func() { result = errors.Join(result, handle.Close()) }()
	var rows []store.ArchiveStagingRecord
	err = op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		leases, e := media.ListSessionResourceLeases(ctx, op.id)
		if e != nil {
			return e
		}
		for _, lease := range leases {
			if lease.Kind == "archive" {
				return archiveBusy("staging_busy")
			}
		}
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		rows, e = d.ArchiveStagingRecords(ctx, op.id)
		return e
	})
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.StagingReleased || row.State != "complete" && row.State != "failed" {
			continue
		}
		if err = handle.Delete(ctx, row.FileID); err != nil {
			return err
		}
		if row.Purpose == "history" || row.State == "failed" {
			file := stagingBundleFile(row)
			if err = op.execution.files.Delete(ctx, archiveFileBucket(file), archiveFilePath(file)); err != nil {
				return err
			}
		}
		err = op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
			d, e := archiveStagingDAO(dao)
			if e != nil {
				return e
			}
			current, e := d.ArchiveStagingRecord(ctx, op.id, row.FileID)
			if e != nil {
				return e
			}
			if !sameStreamRecord(current, row) || current.State != row.State {
				return archiveConflict()
			}
			if current.StagingReleased {
				return nil
			}
			changed, e := d.ReleaseArchiveStaging(ctx, current)
			if e != nil {
				return e
			}
			if !changed {
				return archiveConflict()
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (op *ArchiveOperation) retryArchiveStreamCleanup(ctx context.Context) {
	cleanup, cancel := filestorage.GateCleanupContext(ctx)
	defer cancel()
	if err := op.cleanupArchiveStreamTerminal(cleanup); err != nil {
		slog.ErrorContext(ctx, "Archive staging cleanup failed", "session_id", op.id, "error", err)
	}
}
