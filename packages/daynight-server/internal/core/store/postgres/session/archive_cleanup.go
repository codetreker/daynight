package session

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type archiveCleanupScope struct {
	tx     pgx.Tx
	target store.ArchiveCleanupTarget
}

// NewArchiveCleanup requires the Project lock before selecting the Session.
func NewArchiveCleanup(ctx context.Context, tx pgx.Tx, expected store.ArchiveCleanupTarget) (store.ArchiveCleanupScope, error) {
	var target store.ArchiveCleanupTarget
	err := tx.QueryRow(ctx, `SELECT s.project_id::text,s.task_id::text,s.id::text,s.owner_user_id::text
 FROM task_sessions s JOIN task_resource_rows t ON t.id=s.task_id AND t.project_id=s.project_id
 WHERE s.id=$1 AND s.project_id=$2 AND s.task_id=$3 AND s.owner_user_id=$4
 AND s.scope='task' AND s.backend='web' AND s.bot_id IS NULL AND t.type='task'
 AND (t.effective_deleted_at IS NULL OR EXISTS(SELECT 1 FROM session_archive_retention r WHERE r.session_id=s.id AND r.expired_at IS NOT NULL))
 FOR UPDATE OF s`, expected.SessionID, expected.ProjectID, expected.TaskID, expected.OwnerID).Scan(&target.ProjectID, &target.TaskID, &target.SessionID, &target.OwnerID)
	if err != nil {
		return nil, pg.QueryError("lock archive cleanup session", err)
	}
	err = tx.QueryRow(ctx, `SELECT expired_at,cleaned_at FROM session_archive_retention WHERE session_id=$1 FOR UPDATE`, target.SessionID).Scan(&target.ExpiredAt, &target.CleanedAt)
	if err != nil {
		return nil, pg.QueryError("lock archive cleanup retention", err)
	}
	return &archiveCleanupScope{tx: tx, target: target}, nil
}

func (s *archiveCleanupScope) RetentionDAO() store.ArchiveRetentionDAO {
	return NewArchiveRetention(s.tx, s.target.ProjectID)
}
func (s *archiveCleanupScope) SessionDAO() store.SessionDAO       { return New(s.tx) }
func (s *archiveCleanupScope) Target() store.ArchiveCleanupTarget { return s.target }

func (s *archiveCleanupScope) ExpireArchive(ctx context.Context, expected int64, at time.Time) error {
	tag, err := s.tx.Exec(ctx, `UPDATE session_archive_retention r SET expired_at=$3,reason='expired',version=version+1
 WHERE session_id=$1 AND version=$2 AND expired_at IS NULL AND expires_at IS NOT NULL AND expires_at<=$3
 AND EXISTS(SELECT 1 FROM session_archives a WHERE a.session_id=r.session_id AND a.state='ready')`, s.target.SessionID, expected, at)
	if err != nil {
		return pg.QueryError("expire archive", err)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "version_conflict", Message: "Archive expiration facts changed."}
	}
	// Captures prove which message pins belong to this completed Session's
	// history. Unrecognized pins and operation/upload/resume ownership survive.
	rows, err := s.tx.Query(ctx, `DELETE FROM session_resource_references ref WHERE session_id=$1 AND
 (kind='archive' OR (kind='message' AND EXISTS(SELECT 1 FROM session_image_captures capture
 WHERE capture.session_id=ref.session_id AND capture.image_id::text=ref.reference_id
 AND capture.receipt->>'state'='committed' AND capture.receipt->>'resourceId'=ref.resource_id::text)))
 RETURNING resource_id::text`, s.target.SessionID)
	if err != nil {
		return pg.QueryError("retire archive resource references", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return pg.QueryError("scan retired archive resource", err)
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return pg.QueryError("retire archive resource references", err)
	}
	_, err = s.tx.Exec(ctx, `UPDATE session_resources resource SET gc_pending=true
 WHERE session_id=$1 AND resource_id=ANY($2::uuid[])
 AND NOT EXISTS(SELECT 1 FROM session_resource_references ref WHERE ref.session_id=resource.session_id
 AND ref.resource_id=resource.resource_id)
 AND NOT EXISTS(SELECT 1 FROM session_resources other
 WHERE (other.session_id<>resource.session_id OR other.resource_id<>resource.resource_id)
 AND ((other.session_id=resource.session_id AND other.blob_id=resource.blob_id)
 OR (resource.blob_path IS NOT NULL AND other.blob_path=resource.blob_path)))`, s.target.SessionID, ids)
	if err != nil {
		return pg.QueryError("mark expired archive resources", err)
	}
	s.target.ExpiredAt = &at
	return nil
}

func (s *archiveCleanupScope) CompleteArchiveCleanup(ctx context.Context, at time.Time) error {
	tag, err := s.tx.Exec(ctx, `UPDATE session_archive_retention r SET cleaned_at=COALESCE(cleaned_at,$2)
 WHERE session_id=$1 AND expired_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM session_resources WHERE session_id=$1 AND gc_pending)
 AND NOT EXISTS(SELECT 1 FROM session_resource_leases WHERE session_id=$1)`, s.target.SessionID, at)
	if err != nil {
		return pg.QueryError("complete archive cleanup", err)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "resource_busy", Message: "Archive reclamation has not finished."}
	}
	// Old inline timeline rows can predate file-backed history. Preserve operation
	// receipts and recovery intents, which have independent owners.
	for _, table := range []string{"session_archive_chunks", "session_archive_files", "session_archive_bundles", "session_archive_migrations", "session_events", "session_timeline"} {
		if _, err = s.tx.Exec(ctx, `DELETE FROM `+table+` WHERE session_id=$1`, s.target.SessionID); err != nil {
			return pg.QueryError("remove expired legacy history", err)
		}
	}
	return nil
}

var _ store.SessionArchiveExpiryDAO = (*DAO)(nil)

func (d *DAO) SessionArchiveExpired(ctx context.Context, id string) (bool, error) {
	var expired bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_archive_retention WHERE session_id=$1 AND expired_at IS NOT NULL)`, id).Scan(&expired)
	if err != nil {
		return false, pg.QueryError("read archive expiration", err)
	}
	return expired, nil
}
