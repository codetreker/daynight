package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

var _ store.SessionArchiveDAO = (*DAO)(nil)
var _ store.SessionArchiveHandoffDAO = (*DAO)(nil)
var _ store.SessionArchiveV2DAO = (*DAO)(nil)

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
	err := tx.tx.QueryRow(ctx, `SELECT purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released,upload_version,prefix_proof,coalesce(successor_file_id::text,''),terminal_error FROM session_archive_files WHERE session_id=$1 AND file_id=$2 FOR UPDATE`, session, id).Scan(&v.Purpose, &v.SHA256, &v.ByteLength, &v.AcceptedOffset, &v.State, &v.Path, &v.Resource, &v.TimelineRevision, &v.StagingReleased, &v.UploadVersion, &v.PrefixProof, &v.SuccessorFileID, &v.TerminalError)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, model.ErrNotFound
	}
	if err == nil {
		err = validateArchiveFileVersion(v)
	}
	return v, err
}
func (tx *DAO) SaveSessionArchiveFile(ctx context.Context, v store.ArchiveBundleFile) error {
	if v.UploadVersion == 2 {
		if err := validateArchiveFileVersion(v); err != nil {
			return err
		}
		result, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released,upload_version,prefix_proof,successor_file_id,terminal_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,2,$12,nullif($13,'')::uuid,$14) ON CONFLICT(session_id,file_id) DO NOTHING`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.AcceptedOffset, v.State, v.Path, archiveFileResource(v.Resource), archiveFileRevision(v.TimelineRevision), v.StagingReleased, v.PrefixProof, v.SuccessorFileID, nullableArchiveJSON(v.TerminalError))
		if err == nil && result.RowsAffected() != 1 {
			return errors.New("archive identity conflict")
		}
		return err
	}
	if v.UploadVersion != 0 && v.UploadVersion != 1 {
		return errors.New("unsupported archive upload version")
	}
	v.UploadVersion = 1
	if err := validateArchiveFileVersion(v); err != nil {
		return err
	}
	result, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(session_id,file_id) DO UPDATE SET accepted_offset=excluded.accepted_offset,state=excluded.state,staging_released=excluded.staging_released WHERE session_archive_files.upload_version=1 AND session_archive_files.purpose=excluded.purpose AND session_archive_files.sha256=excluded.sha256 AND session_archive_files.byte_length=excluded.byte_length AND session_archive_files.object_path=excluded.object_path AND session_archive_files.resource=excluded.resource AND session_archive_files.timeline_revision=excluded.timeline_revision`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.AcceptedOffset, v.State, v.Path, archiveFileResource(v.Resource), archiveFileRevision(v.TimelineRevision), v.StagingReleased)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}

func (tx *DAO) CompareAndSwapSessionArchiveFile(ctx context.Context, previous, next store.ArchiveBundleFile) error {
	if err := validateArchiveFileVersion(previous); err != nil {
		return err
	}
	if err := validateArchiveFileVersion(next); err != nil {
		return err
	}
	if previous.UploadVersion != 2 || next.UploadVersion != 2 || previous.SessionID != next.SessionID || previous.FileID != next.FileID || previous.Purpose != next.Purpose || previous.SHA256 != next.SHA256 || previous.ByteLength != next.ByteLength || previous.Path != next.Path || archiveFileRevision(previous.TimelineRevision) != archiveFileRevision(next.TimelineRevision) || !bytes.Equal(archiveFileResource(previous.Resource), archiveFileResource(next.Resource)) {
		return errors.New("archive identity conflict")
	}
	result, err := tx.tx.Exec(ctx, `UPDATE session_archive_files SET accepted_offset=$15,state=$16,staging_released=$17,prefix_proof=$18,successor_file_id=nullif($19,'')::uuid,terminal_error=$20 WHERE session_id=$1 AND file_id=$2 AND purpose=$3 AND sha256=$4 AND byte_length=$5 AND accepted_offset=$6 AND state=$7 AND object_path=$8 AND resource=$9 AND timeline_revision=$10 AND staging_released=$11 AND upload_version=2 AND prefix_proof=$12 AND successor_file_id IS NOT DISTINCT FROM nullif($13,'')::uuid AND terminal_error IS NOT DISTINCT FROM $14::jsonb`, previous.SessionID, previous.FileID, previous.Purpose, previous.SHA256, previous.ByteLength, previous.AcceptedOffset, previous.State, previous.Path, archiveFileResource(previous.Resource), archiveFileRevision(previous.TimelineRevision), previous.StagingReleased, previous.PrefixProof, previous.SuccessorFileID, nullableArchiveJSON(previous.TerminalError), next.AcceptedOffset, next.State, next.StagingReleased, next.PrefixProof, next.SuccessorFileID, nullableArchiveJSON(next.TerminalError))
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}

func validateArchiveFileVersion(v store.ArchiveBundleFile) error {
	switch v.UploadVersion {
	case 1:
		if len(v.PrefixProof) != 0 || v.SuccessorFileID != "" || len(v.TerminalError) != 0 {
			return errors.New("invalid v1 archive upload state")
		}
	case 2:
		if len(v.PrefixProof) != 32 {
			return errors.New("invalid archive prefix proof")
		}
	default:
		return errors.New("unsupported archive upload version")
	}
	return nil
}

func nullableArchiveJSON(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	return value
}
func (tx *DAO) FailSessionArchiveFile(ctx context.Context, v store.ArchiveBundleFile, resource json.RawMessage) error {
	result, err := tx.tx.Exec(ctx, `UPDATE session_archive_files SET state='failed',resource=$12 WHERE session_id=$1 AND file_id=$2 AND upload_version=1 AND purpose=$3 AND sha256=$4 AND byte_length=$5 AND accepted_offset=$6 AND state='receiving' AND object_path=$8 AND resource=$9 AND timeline_revision=$10 AND staging_released=$11 AND $7='receiving'`, v.SessionID, v.FileID, v.Purpose, v.SHA256, v.ByteLength, v.AcceptedOffset, v.State, v.Path, archiveFileResource(v.Resource), archiveFileRevision(v.TimelineRevision), v.StagingReleased, resource)
	if err == nil && result.RowsAffected() != 1 {
		return errors.New("archive identity conflict")
	}
	return err
}
func (tx *DAO) SessionArchiveFiles(ctx context.Context, id string) ([]store.ArchiveBundleFile, error) {
	rows, err := tx.tx.Query(ctx, `SELECT file_id::text,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released,upload_version,prefix_proof,coalesce(successor_file_id::text,''),terminal_error FROM session_archive_files WHERE session_id=$1 ORDER BY file_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []store.ArchiveBundleFile{}
	for rows.Next() {
		v := store.ArchiveBundleFile{SessionID: id}
		if err := rows.Scan(&v.FileID, &v.Purpose, &v.SHA256, &v.ByteLength, &v.AcceptedOffset, &v.State, &v.Path, &v.Resource, &v.TimelineRevision, &v.StagingReleased, &v.UploadVersion, &v.PrefixProof, &v.SuccessorFileID, &v.TerminalError); err != nil {
			return nil, err
		}
		if err := validateArchiveFileVersion(v); err != nil {
			return nil, err
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
