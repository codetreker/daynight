package session_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestLegacyArchiveDAOCannotChangeNewUpload(t *testing.T) {
	db := isolatedStore(t)
	_, id := prepareArchiveSession(t, db)
	ctx := t.Context()
	file := store.ArchiveBundleFile{SessionID: id, FileID: uuid.NewString(), Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, AcceptedOffset: 4, State: "receiving", Path: "history/original", TimelineRevision: 1}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,prefix_proof) VALUES($1,$2,$3,$4,$5,$6,$7,$8,2,decode(repeat('01',32),'hex'))`, id, file.FileID, file.Purpose, file.SHA256, file.ByteLength, file.AcceptedOffset, file.State, file.Path); err != nil {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		if got, err := dao.SessionArchiveFile(ctx, id, file.FileID); err != nil || got.UploadVersion != 2 || len(got.PrefixProof) != 32 {
			t.Fatalf("v2 lookup: %+v %v", got, err)
		}
		if got, err := dao.SessionArchiveFiles(ctx, id); err != nil || len(got) != 1 || got[0].UploadVersion != 2 {
			t.Fatalf("v2 enumeration: %+v %v", got, err)
		}
		changed := file
		changed.AcceptedOffset = 8
		if err := dao.SaveSessionArchiveFile(ctx, changed); err == nil {
			t.Fatal("legacy write replaced v2 offset")
		}
		if err := base.(store.SessionArchiveFailureDAO).FailSessionArchiveFile(ctx, file, json.RawMessage(`{"failure":"error"}`)); err == nil {
			t.Fatal("legacy failure replaced v2 state")
		}
		return nil
	})
	var offset int64
	var state string
	var proof []byte
	if err := db.Pool.QueryRow(ctx, `SELECT accepted_offset,state,prefix_proof FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, id, file.FileID).Scan(&offset, &state, &proof); err != nil || offset != 4 || state != "receiving" || len(proof) != 32 {
		t.Fatalf("v2 state changed: offset=%d state=%s proof=%x err=%v", offset, state, proof, err)
	}
}

func TestArchiveV2CompareAndSwap(t *testing.T) {
	db := isolatedStore(t)
	_, id := prepareArchiveSession(t, db)
	ctx := t.Context()
	proof := bytes.Repeat([]byte{1}, 32)
	file := store.ArchiveBundleFile{SessionID: id, FileID: uuid.NewString(), Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, State: "receiving", Path: "history/original", TimelineRevision: 1, Resource: json.RawMessage(`{"source":"fixed"}`), UploadVersion: 2, PrefixProof: proof}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, file)
	})
	var saved store.ArchiveBundleFile
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		var err error
		saved, err = base.(store.SessionArchiveDAO).SessionArchiveFile(ctx, id, file.FileID)
		return err
	})
	next := saved
	next.AcceptedOffset = 8
	next.PrefixProof = bytes.Repeat([]byte{2}, 32)
	rollback := errors.New("reject transaction")
	completion, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
		if err := scope.SessionDAO().(store.SessionArchiveV2DAO).CompareAndSwapSessionArchiveFile(ctx, saved, next); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		cas := base.(store.SessionArchiveV2DAO)
		got, err := dao.SessionArchiveFile(ctx, id, file.FileID)
		if err != nil || got.AcceptedOffset != 0 || !bytes.Equal(got.PrefixProof, proof) {
			t.Fatalf("rollback changed file: %+v %v", got, err)
		}
		if err := cas.CompareAndSwapSessionArchiveFile(ctx, saved, next); err != nil {
			return err
		}
		if err := cas.CompareAndSwapSessionArchiveFile(ctx, saved, next); err == nil {
			t.Fatal("stale offset/proof accepted")
		}
		changedIdentity := next
		changedIdentity.SHA256 = archiveHashOf("different")
		if err := cas.CompareAndSwapSessionArchiveFile(ctx, next, changedIdentity); err == nil {
			t.Fatal("changed identity accepted")
		}
		if err := dao.SaveSessionArchiveFile(ctx, next); err == nil {
			t.Fatal("v2 insertion overwrote existing state")
		}
		return nil
	})
	failed := next
	failed.State = "failed"
	failed.TerminalError = json.RawMessage(`{"code":"staging_corrupt"}`)
	failed.SuccessorFileID = uuid.NewString()
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionArchiveV2DAO).CompareAndSwapSessionArchiveFile(ctx, next, failed)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		got, err := base.(store.SessionArchiveDAO).SessionArchiveFile(ctx, id, file.FileID)
		if err != nil || got.State != "failed" || got.SuccessorFileID != failed.SuccessorFileID || !jsonEqualArchive(got.TerminalError, failed.TerminalError) || !bytes.Equal(got.PrefixProof, next.PrefixProof) {
			t.Fatalf("terminal state: %+v %v", got, err)
		}
		wrong := got
		wrong.TerminalError = json.RawMessage(`{"code":"other"}`)
		released := got
		released.StagingReleased = true
		if err := base.(store.SessionArchiveV2DAO).CompareAndSwapSessionArchiveFile(ctx, wrong, released); err == nil {
			t.Fatal("stale terminal error accepted")
		}
		return base.(store.SessionArchiveV2DAO).CompareAndSwapSessionArchiveFile(ctx, got, released)
	})
}
