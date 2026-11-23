package session_test

import (
	"encoding/json"
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
		if _, err := dao.SessionArchiveFile(ctx, id, file.FileID); err == nil {
			t.Fatal("legacy lookup accepted v2")
		}
		if _, err := dao.SessionArchiveFiles(ctx, id); err == nil {
			t.Fatal("legacy enumeration accepted v2")
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
