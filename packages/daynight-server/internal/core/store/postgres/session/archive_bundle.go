package session

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

var _ store.SessionArchiveDAO = (*DAO)(nil)
var _ store.SessionArchiveHandoffDAO = (*DAO)(nil)

func (tx *DAO) RebindSessionArchiveBundle(ctx context.Context, id string, previous, next json.RawMessage) error {
	result, err := tx.tx.Exec(ctx, `UPDATE session_archive_bundles SET identity=$3 WHERE session_id=$1 AND phase='active' AND identity=$2`, id, previous, next)
	if err != nil {
		return mediaQueryError("handoff active archive writer", err)
	}
	if result.RowsAffected() != 1 {
		return &model.Fault{Code: "archive_conflict", Message: "The active archive writer no longer matches."}
	}
	return nil
}

func (tx *DAO) SessionArchiveBundle(ctx context.Context, id string) (store.ArchiveBundle, error) {
	v := store.ArchiveBundle{SessionID: id}
	err := tx.tx.QueryRow(ctx, `SELECT prepare_id::text,phase,revision,identity,resources,ledger,coalesce(history_id::text,''),coalesce(timeline_id::text,''),manifest_path,manifest_hash,manifest_length FROM session_archive_bundles WHERE session_id=$1 FOR UPDATE`, id).Scan(&v.PrepareID, &v.Phase, &v.Revision, &v.Identity, &v.Resources, &v.Ledger, &v.HistoryID, &v.TimelineID, &v.ManifestPath, &v.ManifestHash, &v.ManifestLength)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, model.ErrNotFound
	}
	return v, err
}
func (tx *DAO) SaveSessionArchiveBundle(ctx context.Context, v store.ArchiveBundle) error {
	result, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,resources,ledger,history_id,timeline_id,manifest_path,manifest_hash,manifest_length) VALUES($1,$2,$3,$4,$5,$6,$7,nullif($8,'')::uuid,nullif($9,'')::uuid,$10,$11,$12) ON CONFLICT(session_id) DO UPDATE SET phase=excluded.phase,revision=excluded.revision,resources=excluded.resources,ledger=excluded.ledger,history_id=excluded.history_id,timeline_id=excluded.timeline_id,manifest_path=excluded.manifest_path,manifest_hash=excluded.manifest_hash,manifest_length=excluded.manifest_length WHERE session_archive_bundles.prepare_id=excluded.prepare_id AND session_archive_bundles.identity=excluded.identity`, v.SessionID, v.PrepareID, v.Phase, v.Revision, v.Identity, v.Resources, v.Ledger, v.HistoryID, v.TimelineID, v.ManifestPath, v.ManifestHash, v.ManifestLength)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}
func (tx *DAO) SessionArchiveFile(ctx context.Context, session, id string) (store.ArchiveBundleFile, error) {
	v := store.ArchiveBundleFile{SessionID: session, FileID: id}
	var version int
	err := tx.tx.QueryRow(ctx, `SELECT purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released,upload_version FROM session_archive_files WHERE session_id=$1 AND file_id=$2 FOR UPDATE`, session, id).Scan(&v.Purpose, &v.SHA256, &v.ByteLength, &v.AcceptedOffset, &v.State, &v.Path, &v.Resource, &v.TimelineRevision, &v.StagingReleased, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, model.ErrNotFound
	}
	if err == nil && version != 1 {
		return v, errors.New("unsupported archive upload version")
	}
	return v, err
}
func (tx *DAO) SaveSessionArchiveFile(ctx context.Context, v store.ArchiveBundleFile) error {
	result, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(session_id,file_id) DO UPDATE SET accepted_offset=excluded.accepted_offset,state=excluded.state,staging_released=excluded.staging_released WHERE session_archive_files.upload_version=1 AND session_archive_files.purpose=excluded.purpose AND session_archive_files.sha256=excluded.sha256 AND session_archive_files.byte_length=excluded.byte_length AND session_archive_files.object_path=excluded.object_path AND session_archive_files.resource=excluded.resource AND session_archive_files.timeline_revision=excluded.timeline_revision`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.AcceptedOffset, v.State, v.Path, archiveFileResource(v.Resource), archiveFileRevision(v.TimelineRevision), v.StagingReleased)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}
func (tx *DAO) FailSessionArchiveFile(ctx context.Context, v store.ArchiveBundleFile, resource json.RawMessage) error {
	result, err := tx.tx.Exec(ctx, `UPDATE session_archive_files SET state='failed',resource=$12 WHERE session_id=$1 AND file_id=$2 AND upload_version=1 AND purpose=$3 AND sha256=$4 AND byte_length=$5 AND accepted_offset=$6 AND state='receiving' AND object_path=$8 AND resource=$9 AND timeline_revision=$10 AND staging_released=$11 AND $7='receiving'`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.AcceptedOffset, v.State, v.Path, archiveFileResource(v.Resource), archiveFileRevision(v.TimelineRevision), v.StagingReleased, resource)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}
func (tx *DAO) SessionArchiveFiles(ctx context.Context, id string) ([]store.ArchiveBundleFile, error) {
	rows, err := tx.tx.Query(ctx, `SELECT file_id::text,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released,upload_version FROM session_archive_files WHERE session_id=$1 AND upload_version=1 ORDER BY file_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.ArchiveBundleFile{}
	for rows.Next() {
		v := store.ArchiveBundleFile{SessionID: id}
		var version int
		if err := rows.Scan(&v.FileID, &v.Purpose, &v.SHA256, &v.ByteLength, &v.AcceptedOffset, &v.State, &v.Path, &v.Resource, &v.TimelineRevision, &v.StagingReleased, &version); err != nil {
			return nil, err
		}
		if version != 1 {
			return nil, errors.New("unsupported archive upload version")
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (tx *DAO) SessionArchiveMigration(ctx context.Context, id string) (store.ArchiveMigration, error) {
	v := store.ArchiveMigration{SessionID: id}
	err := tx.tx.QueryRow(ctx, `SELECT migration_id::text,source_path,source_hash,source_byte_length,target_path,target_hash,phase FROM session_archive_migrations WHERE session_id=$1 FOR UPDATE`, id).Scan(&v.MigrationID, &v.SourcePath, &v.SourceHash, &v.SourceLength, &v.TargetPath, &v.TargetHash, &v.Phase)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, model.ErrNotFound
	}
	return v, err
}
func (tx *DAO) SaveSessionArchiveMigration(ctx context.Context, v store.ArchiveMigration) error {
	result, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_migrations(session_id,migration_id,source_path,source_hash,source_byte_length,target_path,target_hash,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_id) DO UPDATE SET target_path=excluded.target_path,target_hash=excluded.target_hash,phase=excluded.phase WHERE session_archive_migrations.migration_id=excluded.migration_id AND session_archive_migrations.source_hash=excluded.source_hash AND session_archive_migrations.source_byte_length=excluded.source_byte_length AND session_archive_migrations.source_path=excluded.source_path`, v.SessionID, v.MigrationID, v.SourcePath, v.SourceHash, v.SourceLength, v.TargetPath, v.TargetHash, v.Phase)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}
func (tx *DAO) SetUnifiedSessionArchiveReady(ctx context.Context, id, digest string, size int, path, completeness string) error {
	result, err := tx.tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,schema_version,completeness) VALUES($1,'ready',$2,$3,$4,3,$5) ON CONFLICT(session_id) DO UPDATE SET state='ready',sha256=excluded.sha256,byte_length=excluded.byte_length,object_path=excluded.object_path,schema_version=3,completeness=excluded.completeness,error_code=NULL,finalization_id=NULL,receipt=NULL,updated_at=now()`, id, digest, size, path, completeness)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}

func (tx *DAO) SessionArchiveChunks(ctx context.Context, session, id string) ([]store.ArchiveBundleChunk, error) {
	rows, err := tx.tx.Query(ctx, `SELECT chunk_offset,byte_length,sha256,object_path FROM session_archive_chunks WHERE session_id=$1 AND file_id=$2 ORDER BY chunk_offset`, session, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.ArchiveBundleChunk{}
	for rows.Next() {
		v := store.ArchiveBundleChunk{SessionID: session, FileID: id}
		if err := rows.Scan(&v.Offset, &v.ByteLength, &v.SHA256, &v.Path); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (tx *DAO) InsertSessionArchiveChunk(ctx context.Context, v store.ArchiveBundleChunk) error {
	result, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,file_id,chunk_offset) DO UPDATE SET sha256=excluded.sha256 WHERE session_archive_chunks.sha256=excluded.sha256 AND session_archive_chunks.byte_length=excluded.byte_length AND session_archive_chunks.object_path=excluded.object_path`, v.SessionID, v.FileID, v.Offset, v.ByteLength, v.SHA256, v.Path)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}

func archiveFileResource(value []byte) []byte {
	if len(value) == 0 {
		return []byte("null")
	}
	return value
}

func archiveFileRevision(value int64) int64 {
	if value == 0 {
		return 1
	}
	return value
}

var _ store.SessionArchiveStagingDAO = (*DAO)(nil)

func (tx *DAO) ArchiveStagingRecord(ctx context.Context, session, id string) (store.ArchiveStagingRecord, error) {
	v := store.ArchiveStagingRecord{SessionID: session, FileID: id}
	err := tx.tx.QueryRow(ctx, `SELECT purpose,sha256,byte_length,state,object_path,resource,timeline_revision,staging_released,accepted_offset,coalesce(successor_file_id::text,''),terminal_error FROM session_archive_files WHERE session_id=$1 AND file_id=$2 AND upload_version=2 FOR UPDATE`, session, id).Scan(&v.Purpose, &v.SHA256, &v.ByteLength, &v.State, &v.Path, &v.Resource, &v.TimelineRevision, &v.StagingReleased, &v.TerminalOffset, &v.SuccessorFileID, &v.TerminalError)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, model.ErrNotFound
	}
	return v, err
}

func (tx *DAO) ArchiveStagingRecords(ctx context.Context, session string) ([]store.ArchiveStagingRecord, error) {
	rows, err := tx.tx.Query(ctx, `SELECT file_id::text,purpose,sha256,byte_length,state,object_path,resource,timeline_revision,staging_released,accepted_offset,coalesce(successor_file_id::text,''),terminal_error FROM session_archive_files WHERE session_id=$1 AND upload_version=2 ORDER BY file_id FOR UPDATE`, session)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []store.ArchiveStagingRecord
	for rows.Next() {
		v := store.ArchiveStagingRecord{SessionID: session}
		if err := rows.Scan(&v.FileID, &v.Purpose, &v.SHA256, &v.ByteLength, &v.State, &v.Path, &v.Resource, &v.TimelineRevision, &v.StagingReleased, &v.TerminalOffset, &v.SuccessorFileID, &v.TerminalError); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}

func (tx *DAO) InsertArchiveStaging(ctx context.Context, v store.ArchiveStagingRecord) (bool, error) {
	result, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released,upload_version) VALUES($1,$2,$3,$4,$5,0,'receiving',$6,$7,$8,false,2) ON CONFLICT(session_id,file_id) DO NOTHING`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.Path, archiveFileResource(v.Resource), v.TimelineRevision)
	return err == nil && result.RowsAffected() == 1, err
}

func (tx *DAO) FinishArchiveStaging(ctx context.Context, v store.ArchiveStagingRecord, state string, offset int64, terminal json.RawMessage) (bool, error) {
	if state != "complete" && state != "failed" {
		return false, errors.New("invalid archive terminal state")
	}
	result, err := tx.tx.Exec(ctx, `UPDATE session_archive_files SET state=$9,accepted_offset=$10,terminal_error=$11 WHERE session_id=$1 AND file_id=$2 AND upload_version=2 AND state='receiving' AND NOT staging_released AND purpose=$3 AND sha256=$4 AND byte_length=$5 AND object_path=$6 AND resource=$7 AND timeline_revision=$8`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.Path, archiveFileResource(v.Resource), v.TimelineRevision, state, offset, terminal)
	return err == nil && result.RowsAffected() == 1, err
}

func (tx *DAO) SetArchiveStagingSuccessor(ctx context.Context, v store.ArchiveStagingRecord, successor string) (bool, error) {
	result, err := tx.tx.Exec(ctx, `UPDATE session_archive_files SET successor_file_id=$9::uuid WHERE session_id=$1 AND file_id=$2 AND upload_version=2 AND state='failed' AND successor_file_id IS NULL AND purpose=$3 AND sha256=$4 AND byte_length=$5 AND object_path=$6 AND resource=$7 AND timeline_revision=$8`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.Path, archiveFileResource(v.Resource), v.TimelineRevision, successor)
	return err == nil && result.RowsAffected() == 1, err
}

func (tx *DAO) ReleaseArchiveStaging(ctx context.Context, v store.ArchiveStagingRecord) (bool, error) {
	result, err := tx.tx.Exec(ctx, `UPDATE session_archive_files SET staging_released=true WHERE session_id=$1 AND file_id=$2 AND upload_version=2 AND state IN ('complete','failed') AND NOT staging_released AND purpose=$3 AND sha256=$4 AND byte_length=$5 AND object_path=$6 AND resource=$7 AND timeline_revision=$8`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.Path, archiveFileResource(v.Resource), v.TimelineRevision)
	return err == nil && result.RowsAffected() == 1, err
}
