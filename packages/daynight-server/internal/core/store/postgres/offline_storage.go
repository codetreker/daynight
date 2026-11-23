package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadOfflineStorageState(ctx context.Context) (out store.OfflineStorageState, result error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	err = transactReadOnly(ctx, tx, func(tx pgx.Tx) error {
		out, err = readOfflineStorageState(ctx, tx)
		return err
	})
	return out, err
}

func readOfflineStorageState(ctx context.Context, tx pgx.Tx) (out store.OfflineStorageState, result error) {
	rows, err := tx.Query(ctx, `SELECT coalesce(s.project_id::text,''),s.owner_user_id::text,f.session_id::text,f.file_id::text,f.purpose,f.sha256,f.byte_length,f.accepted_offset,f.state,f.object_path,f.resource,f.timeline_revision,f.staging_released,f.upload_version,coalesce(f.successor_file_id::text,''),f.terminal_error FROM session_archive_files f JOIN task_sessions s ON s.id=f.session_id WHERE f.state='receiving' ORDER BY f.session_id,f.file_id`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		v := store.OfflineArchiveFile{}
		f := &v.File
		if err = rows.Scan(&v.ProjectID, &v.OwnerID, &f.SessionID, &f.FileID, &f.Purpose, &f.SHA256, &f.ByteLength, &f.AcceptedOffset, &f.State, &f.Path, &f.Resource, &f.TimelineRevision, &f.StagingReleased, &f.UploadVersion, &f.SuccessorFileID, &f.TerminalError); err != nil {
			rows.Close()
			return out, err
		}
		out.ArchiveFiles = append(out.ArchiveFiles, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	for i := range out.ArchiveFiles {
		v := &out.ArchiveFiles[i]
		bundle := store.ArchiveBundle{SessionID: v.File.SessionID}
		err = tx.QueryRow(ctx, `SELECT prepare_id::text,phase,revision,identity,resources,ledger,coalesce(history_id::text,''),coalesce(timeline_id::text,''),manifest_path,manifest_hash,manifest_length FROM session_archive_bundles WHERE session_id=$1`, v.File.SessionID).Scan(&bundle.PrepareID, &bundle.Phase, &bundle.Revision, &bundle.Identity, &bundle.Resources, &bundle.Ledger, &bundle.HistoryID, &bundle.TimelineID, &bundle.ManifestPath, &bundle.ManifestHash, &bundle.ManifestLength)
		if err == nil {
			v.Bundle = &bundle
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		v.Chunks, err = offlineChunks(ctx, tx, `SELECT 'session-archives',object_path,sha256,byte_length FROM session_archive_chunks WHERE session_id=$1 AND file_id=$2 ORDER BY chunk_offset`, v.File.SessionID, v.File.FileID)
		if err != nil {
			return out, err
		}
		predecessors, err := tx.Query(ctx, `SELECT file_id::text,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,staging_released,upload_version,coalesce(successor_file_id::text,''),terminal_error FROM session_archive_files WHERE session_id=$1 AND successor_file_id=$2 ORDER BY file_id`, v.File.SessionID, v.File.FileID)
		if err != nil {
			return out, err
		}
		for predecessors.Next() {
			f := store.ArchiveBundleFile{SessionID: v.File.SessionID}
			if err = predecessors.Scan(&f.FileID, &f.Purpose, &f.SHA256, &f.ByteLength, &f.AcceptedOffset, &f.State, &f.Path, &f.Resource, &f.TimelineRevision, &f.StagingReleased, &f.UploadVersion, &f.SuccessorFileID, &f.TerminalError); err != nil {
				predecessors.Close()
				return out, err
			}
			v.Predecessors = append(v.Predecessors, f)
		}
		err = predecessors.Err()
		predecessors.Close()
		if err != nil {
			return out, err
		}
	}
	rows, err = tx.Query(ctx, `SELECT coalesce(s.project_id::text,''),s.owner_user_id::text,u.session_id::text,u.actor_id::text,u.blob_id::text,u.spec,u.receipt,u.expires_at,u.storage_released FROM session_image_uploads u JOIN task_sessions s ON s.id=u.session_id WHERE u.receipt->>'state' IN ('receiving','verifying') ORDER BY u.session_id,u.upload_id`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		v := store.OfflineImageUpload{}
		u := &v.Upload
		var spec, receipt []byte
		if err = rows.Scan(&v.ProjectID, &v.OwnerID, &u.SessionID, &u.ActorID, &u.BlobID, &spec, &receipt, &u.ExpiresAt, &u.StorageReleased); err != nil {
			rows.Close()
			return out, err
		}
		if err = json.Unmarshal(spec, &u.Spec); err == nil {
			err = json.Unmarshal(receipt, &u.Receipt)
		}
		if err != nil {
			rows.Close()
			return out, err
		}
		out.Uploads = append(out.Uploads, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	for i := range out.Uploads {
		v := &out.Uploads[i]
		v.Chunks, err = offlineChunks(ctx, tx, `SELECT 'session-resources',blob_path,sha256,byte_length FROM session_image_chunks WHERE session_id=$1 AND upload_id=$2 ORDER BY chunk_offset`, v.Upload.SessionID, v.Upload.Spec.UploadID)
		if err != nil {
			return out, err
		}
	}
	rows, err = tx.Query(ctx, `SELECT `+transferColumns+` FROM private_transfers WHERE state<>'closed' ORDER BY id`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		v, err := scanPrivateTransfer(rows)
		if err != nil {
			return out, err
		}
		out.Transfers = append(out.Transfers, v)
	}
	return out, rows.Err()
}

func offlineChunks(ctx context.Context, tx pgx.Tx, query, session, id string) ([]store.StorageObject, error) {
	rows, err := tx.Query(ctx, query, session, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.StorageObject
	for rows.Next() {
		v := store.StorageObject{}
		if err := rows.Scan(&v.Bucket, &v.Path, &v.SHA256, &v.ByteLength); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ApplyOfflineStorageTransition is a target-only transaction. Table exclusion
// protects the observed set from late inserts; changed state refuses the cut.
func (s *Store) ApplyOfflineStorageTransition(ctx context.Context, expected store.OfflineStorageState, uploads []store.SessionUploadRecord, transfers []model.PrivateTransfer, revocations []store.OfflineArchiveRevocation) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `LOCK TABLE task_sessions,session_archive_files,session_archive_chunks,session_archive_bundles,session_image_uploads,session_image_chunks,private_transfers,private_upload_chunks,private_transfer_ledger IN SHARE ROW EXCLUSIVE MODE`); err != nil {
			return err
		}
		current, err := readOfflineStorageState(ctx, tx)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(current, expected) || len(uploads) != len(expected.Uploads) || len(transfers) != len(expected.Transfers) {
			return errors.New("offline storage state changed after verification")
		}
		predecessors := map[string]store.ArchiveBundleFile{}
		for _, item := range expected.ArchiveFiles {
			for _, previous := range item.Predecessors {
				predecessors[previous.SessionID+"/"+previous.FileID] = previous
			}
		}
		if len(predecessors) != len(revocations) {
			return errors.New("offline successor revocation plan mismatch")
		}
		for _, revocation := range revocations {
			key := revocation.SessionID + "/" + revocation.PredecessorFileID
			previous, ok := predecessors[key]
			if !ok || previous.SuccessorFileID != revocation.SuccessorFileID {
				return errors.New("offline successor revocation identity mismatch")
			}
			delete(predecessors, key)
			if _, err := tx.Exec(ctx, `UPDATE session_archive_files SET terminal_error=$3 WHERE session_id=$1 AND file_id=$2`, revocation.SessionID, revocation.PredecessorFileID, revocation.TerminalError); err != nil {
				return err
			}
		}
		for _, item := range expected.ArchiveFiles {
			f := item.File
			if _, err := tx.Exec(ctx, `UPDATE session_archive_bundles SET history_id=CASE WHEN history_id=$2::uuid THEN NULL ELSE history_id END,timeline_id=CASE WHEN timeline_id=$2::uuid THEN NULL ELSE timeline_id END WHERE session_id=$1`, f.SessionID, f.FileID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM session_archive_chunks WHERE session_id=$1 AND file_id=$2`, f.SessionID, f.FileID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM session_archive_files WHERE session_id=$1 AND file_id=$2 AND state='receiving'`, f.SessionID, f.FileID); err != nil {
				return err
			}
		}
		for i, upload := range uploads {
			before := expected.Uploads[i].Upload
			identity := upload
			identity.Receipt, identity.StorageReleased = before.Receipt, before.StorageReleased
			wanted := before.Receipt
			wanted.State, wanted.Resource, wanted.Error = "released", nil, nil
			if !reflect.DeepEqual(identity, before) || !reflect.DeepEqual(upload.Receipt, wanted) || !upload.StorageReleased {
				return errors.New("offline image settlement identity mismatch")
			}
			receipt, err := json.Marshal(upload.Receipt)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE session_image_uploads SET receipt=$3,storage_released=true WHERE session_id=$1 AND upload_id=$2`, before.SessionID, before.Spec.UploadID, receipt); err != nil {
				return err
			}
		}
		dao := &privateTransferDAO{tx: tx}
		for i, closed := range transfers {
			before := expected.Transfers[i]
			if closed.ID != before.ID || closed.State != "closed" || closed.RetainUntil == nil || !reflect.DeepEqual(closed.Data, before.Data) {
				return errors.New("offline transfer settlement identity mismatch")
			}
			pending := before
			pending.State, pending.CleanupFromState, pending.LeaseUntil = "cleanup_pending", closed.CleanupFromState, nil
			pending, err = dao.Put(ctx, pending, before.Version)
			if err != nil {
				return err
			}
			if err = dao.LockLedger(ctx); err != nil {
				return err
			}
			if _, err = dao.Release(ctx, pending, pending.Version, *closed.RetainUntil, "closed"); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	outcome := store.TransactionUnknown
	var failure *store.TransactionError
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, err
}
