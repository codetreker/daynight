package sessionrelay

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"reflect"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionarchive"
	"github.com/jackc/pgx/v5"
)

const archiveLayoutMigrationLock int64 = 0x444e5341524348

type ArchiveLayoutMigrationSummary struct {
	Phase        string `json:"phase"`
	SessionCount int    `json:"sessionCount"`
	MovedCount   int    `json:"movedCount"`
	FileCount    int    `json:"fileCount"`
	TotalBytes   int64  `json:"totalBytes"`
}

type ArchiveLayoutMigrationError struct {
	Phase, Category, Diagnostic, SessionID string
	Cause                                  error
}

func (e *ArchiveLayoutMigrationError) Error() string { return e.Diagnostic }
func (e *ArchiveLayoutMigrationError) Unwrap() error { return e.Cause }

type archiveLayoutRecord struct {
	id, scope, owner, backend  string
	project, task, claim, test *string
	state, digest, object      *string
	size                       *int64
	version                    *int
	identity, metadata         *string
	namespace                  sessionarchive.Namespace
	oldPath, newPath           string
	directory                  string
	files                      []archiveLayoutFile
}

type archiveLayoutMigration struct {
	database *pgx.Conn
	root     *os.Root
	logger   *slog.Logger
	phase    string
	session  string
}

// MigrateSessionArchiveLayout requires all database and storage writers to remain
// stopped, with a matching database/storage backup. The advisory lock serializes
// maintenance calls only. Retrying verifies file-ahead-of-database moves before
// updating their original metadata; it never merges or overwrites directories.
func MigrateSessionArchiveLayout(ctx context.Context, databaseURL, storageRoot string, logger *slog.Logger) (summary ArchiveLayoutMigrationSummary, result error) {
	m := &archiveLayoutMigration{logger: logger, phase: "configuration"}
	if strings.TrimSpace(databaseURL) == "" || strings.TrimSpace(storageRoot) == "" {
		return summary, m.failure("configuration", "DAYNIGHT_DATABASE_URL and DAYNIGHT_STORAGE_ROOT are required.", nil)
	}
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return summary, m.failure("configuration", "Archive migration database configuration is invalid.", err)
	}
	m.database, err = pgx.ConnectConfig(ctx, config)
	if err != nil {
		return summary, m.failure("database", "Archive migration database could not be connected.", err)
	}
	defer func() { result = errors.Join(result, m.database.Close(context.Background())) }()
	if _, err = m.database.Exec(ctx, "SELECT pg_advisory_lock($1)", archiveLayoutMigrationLock); err != nil {
		return summary, m.failure("database", "Archive migration maintenance lock could not be acquired.", err)
	}
	m.root, err = os.OpenRoot(storageRoot)
	if err != nil {
		return summary, m.failure("filesystem", "Archive migration storage root could not be opened.", err)
	}
	defer func() { result = errors.Join(result, m.root.Close()) }()
	m.phase = "inventory"
	records, err := m.snapshot(ctx)
	if err != nil {
		return summary, err
	}
	if err = m.preflight(ctx, records); err != nil {
		return summary, err
	}
	for _, r := range records {
		if r.directory == "" {
			continue
		}
		m.session = r.id
		m.phase = "placing"
		moved, err := m.apply(ctx, r)
		if err != nil {
			return summary, err
		}
		summary.SessionCount++
		if moved {
			summary.MovedCount++
		}
		for _, f := range r.files {
			if !f.directory {
				summary.FileCount++
				summary.TotalBytes += f.size
			}
		}
		m.logger.InfoContext(ctx, "session archive layout migration", "component", "session_archive_layout_migration", "phase", "verified", "sessionId", r.id, "moved", moved)
	}
	summary.Phase = "complete"
	return summary, nil
}

func (m *archiveLayoutMigration) failure(category, diagnostic string, cause error) error {
	return &ArchiveLayoutMigrationError{Phase: m.phase, Category: category, Diagnostic: diagnostic, SessionID: m.session, Cause: cause}
}

func (m *archiveLayoutMigration) snapshot(ctx context.Context) ([]*archiveLayoutRecord, error) {
	tx, err := m.database.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, m.failure("database", "Archive migration snapshot could not be opened.", err)
	}
	defer tx.Rollback(context.Background())
	var orphan bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_archives a WHERE NOT EXISTS(SELECT 1 FROM task_sessions s WHERE s.id=a.session_id))`).Scan(&orphan); err != nil {
		return nil, m.failure("database", "Archive migration metadata ownership could not be read.", err)
	}
	if orphan {
		return nil, m.failure("unknown_owner", "Archive metadata has no registered Session owner.", nil)
	}
	rows, err := tx.Query(ctx, `SELECT s.id::text,s.scope,s.project_id::text,s.task_id::text,s.claim_id::text,s.test_execution_id::text,s.owner_user_id::text,s.backend,a.state,a.sha256,a.byte_length,a.object_path,a.schema_version,to_jsonb(s)::text,to_jsonb(a)::text FROM task_sessions s LEFT JOIN session_archives a ON a.session_id=s.id ORDER BY s.id`)
	if err != nil {
		return nil, m.failure("database", "Archive migration Session metadata could not be read.", err)
	}
	records := []*archiveLayoutRecord{}
	for rows.Next() {
		r := &archiveLayoutRecord{}
		if err = rows.Scan(&r.id, &r.scope, &r.project, &r.task, &r.claim, &r.test, &r.owner, &r.backend, &r.state, &r.digest, &r.size, &r.object, &r.version, &r.identity, &r.metadata); err != nil {
			rows.Close()
			return nil, m.failure("database", "Archive migration Session row could not be decoded.", err)
		}
		m.session = r.id
		switch r.scope {
		case "task":
			if r.project == nil || r.task == nil || r.claim == nil || r.test != nil {
				rows.Close()
				return nil, m.failure("invalid_metadata", "Task Session archive has no project owner.", nil)
			}
			r.namespace, err = sessionarchive.NewNamespace(sessionarchive.Projects, *r.project, r.id)
		case "test":
			if r.project != nil || r.task != nil || r.claim != nil || r.test == nil {
				rows.Close()
				return nil, m.failure("invalid_metadata", "Independent Session archive has a project owner.", nil)
			}
			r.namespace, err = sessionarchive.NewNamespace(sessionarchive.Users, r.owner, r.id)
		default:
			err = errors.New("invalid Session scope")
		}
		if err != nil {
			rows.Close()
			return nil, m.failure("invalid_metadata", "Archive migration Session ownership is invalid.", err)
		}
		if r.state != nil && *r.state == "ready" {
			if r.digest == nil || r.size == nil || r.object == nil || r.version == nil || *r.size < 1 || *r.size > 64*1024*1024 {
				rows.Close()
				return nil, m.failure("invalid_metadata", "Ready archive manifest is incomplete.", nil)
			}
			r.oldPath = r.id + "/" + *r.digest + ".json"
			r.newPath, err = r.namespace.ObjectPath(*r.digest)
			if err != nil || *r.object != r.oldPath && *r.object != r.newPath || *r.version != 1 && *r.version != 2 || (*r.version == 1) != (r.backend == "web") {
				rows.Close()
				return nil, m.failure("invalid_metadata", "Archive manifest path or version does not match its Session.", err)
			}
		}
		records = append(records, r)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, m.failure("database", "Archive migration Session metadata could not be enumerated.", err)
	}
	rows.Close()
	if err = tx.Commit(ctx); err != nil {
		return nil, m.failure("database", "Archive migration snapshot could not be completed.", err)
	}
	return records, nil
}

func (m *archiveLayoutMigration) apply(ctx context.Context, r *archiveLayoutRecord) (bool, error) {
	tx, err := m.database.Begin(ctx)
	if err != nil {
		return false, m.failure("database", "Archive migration metadata transaction could not be opened.", err)
	}
	defer tx.Rollback(context.Background())
	var identity, metadata *string
	if err = tx.QueryRow(ctx, `SELECT to_jsonb(s)::text FROM task_sessions s WHERE id=$1 FOR UPDATE`, r.id).Scan(&identity); err != nil {
		return false, m.failure("database", "Archive migration Session could not be locked.", err)
	}
	err = tx.QueryRow(ctx, `SELECT to_jsonb(a)::text FROM session_archives a WHERE session_id=$1 FOR UPDATE`, r.id).Scan(&metadata)
	if errors.Is(err, pgx.ErrNoRows) {
		metadata, err = nil, nil
	}
	if err != nil {
		return false, m.failure("database", "Archive migration manifest could not be locked.", err)
	}
	if !reflect.DeepEqual(identity, r.identity) || !reflect.DeepEqual(metadata, r.metadata) {
		return false, m.failure("metadata_changed", "Archive migration ownership or manifest changed after inventory.", nil)
	}
	actual, err := m.inventory(ctx, r.directory)
	if err != nil {
		return false, err
	}
	if !reflect.DeepEqual(actual, r.files) {
		return false, m.failure("content_changed", "Session archive files changed after inventory.", nil)
	}
	moved := r.directory == sessionarchive.Bucket+"/"+r.id
	target := sessionarchive.Bucket + "/" + r.namespace.Directory()
	if moved {
		if err = m.makeParents(ctx, target); err != nil {
			return false, err
		}
		exists, err := m.directoryExists(target)
		if err != nil {
			return false, err
		}
		if exists {
			return false, m.failure("path_conflict", "Archive migration destination already exists.", nil)
		}
		if err = ctx.Err(); err != nil {
			return false, m.failure("canceled", "Archive migration was canceled before moving a Session.", err)
		}
		if err = m.root.Rename(r.directory, target); err != nil {
			return false, m.failure("filesystem", "Archive migration Session directory could not be moved.", err)
		}
	}
	if err = m.syncParents(target); err != nil {
		return moved, err
	}
	if err = m.syncDirectory(sessionarchive.Bucket); err != nil {
		return moved, err
	}
	actual, err = m.inventory(ctx, target)
	if err != nil {
		return moved, err
	}
	if !reflect.DeepEqual(actual, r.files) {
		return moved, m.failure("content_changed", "Moved Session archive files do not match their inventory.", nil)
	}
	if r.object != nil && *r.object == r.oldPath {
		m.phase = "metadata"
		if _, err = tx.Exec(ctx, `UPDATE session_archives SET object_path=$2 WHERE session_id=$1`, r.id, r.newPath); err != nil {
			return moved, m.failure("database", "Moved archive manifest could not be updated; rerun migration with writers stopped.", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return moved, m.failure("database", "Archive migration metadata commit was not confirmed; rerun migration with writers stopped.", err)
	}
	return moved, nil
}
