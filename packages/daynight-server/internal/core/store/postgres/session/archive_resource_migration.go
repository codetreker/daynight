package session

import (
	"context"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var _ store.SessionArchiveResourceMigrationDAO = (*DAO)(nil)

func (tx *DAO) MigrateSessionArchiveResource(ctx context.Context, previous, next store.SessionResourceRecord) error {
	if previous.SessionID != next.SessionID || previous.Resource.ResourceID != next.Resource.ResourceID || previous.BlobID != "" || previous.BlobPath != "" || previous.GCPending || next.GCPending || next.BlobID == "" || next.BlobPath == "" || next.MigrationID == "" {
		return archiveResourceMigrationConflict()
	}
	oldDescriptor, err := json.Marshal(previous.Resource)
	if err != nil {
		return err
	}
	descriptor, err := json.Marshal(next.Resource)
	if err != nil {
		return err
	}
	result, err := tx.tx.Exec(ctx, `UPDATE session_resources SET blob_id=$3,blob_path=$4,migration_id=$5,content=NULL
WHERE session_id=$1 AND resource_id=$2 AND descriptor=$6 AND descriptor=$7
AND blob_id IS NULL AND blob_path IS NULL AND COALESCE(migration_id::text,'')=$8 AND NOT gc_pending`, next.SessionID, next.Resource.ResourceID, next.BlobID, next.BlobPath, next.MigrationID, oldDescriptor, descriptor, previous.MigrationID)
	if err != nil {
		return mediaQueryError("migrate inline archive resource", err)
	}
	if result.RowsAffected() != 1 {
		return archiveResourceMigrationConflict()
	}
	return nil
}

func archiveResourceMigrationConflict() error {
	return &model.Fault{Code: "archive_conflict", Message: "The legacy resource identity no longer matches."}
}
