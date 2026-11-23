package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestArchiveStagingRegistrationAndTerminalReceipt(t *testing.T) {
	db := isolatedStore(t)
	_, id := prepareArchiveSession(t, db)
	ctx := t.Context()
	original := store.ArchiveStagingRecord{SessionID: id, FileID: uuid.NewString(), Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, Path: "history/original", TimelineRevision: 1, Resource: json.RawMessage(`null`)}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveStagingDAO)
		ok, err := dao.InsertArchiveStaging(ctx, original)
		if err != nil || !ok {
			t.Fatalf("insert: %t %v", ok, err)
		}
		changed := original
		changed.SHA256 = archiveHashOf("different")
		ok, err = dao.InsertArchiveStaging(ctx, changed)
		if err != nil || ok {
			t.Fatalf("conflicting insert: %t %v", ok, err)
		}
		row, err := dao.ArchiveStagingRecord(ctx, id, original.FileID)
		if err != nil || row.SHA256 != original.SHA256 || row.State != "receiving" || row.TerminalOffset != 0 {
			t.Fatalf("original: %+v %v", row, err)
		}
		ok, err = dao.FinishArchiveStaging(ctx, original, "receiving", 0, nil)
		if err == nil || ok {
			t.Fatalf("nonterminal finish accepted: %t %v", ok, err)
		}
		ok, err = dao.FinishArchiveStaging(ctx, changed, "failed", 0, json.RawMessage(`{"code":"staging_corrupt"}`))
		if err != nil || ok {
			t.Fatalf("changed identity finished: %t %v", ok, err)
		}
		ok, err = dao.ReleaseArchiveStaging(ctx, original)
		if err != nil || ok {
			t.Fatalf("released receiving: %t %v", ok, err)
		}
		ok, err = dao.FinishArchiveStaging(ctx, original, "failed", 4, json.RawMessage(`{"code":"staging_corrupt"}`))
		if err != nil || !ok {
			t.Fatalf("finish: %t %v", ok, err)
		}
		ok, err = dao.FinishArchiveStaging(ctx, original, "complete", 8, nil)
		if err != nil || ok {
			t.Fatalf("finished record changed: %t %v", ok, err)
		}
		next := uuid.NewString()
		ok, err = dao.SetArchiveStagingSuccessor(ctx, original, next)
		if err != nil || !ok {
			t.Fatalf("successor: %t %v", ok, err)
		}
		ok, err = dao.SetArchiveStagingSuccessor(ctx, original, uuid.NewString())
		if err != nil || ok {
			t.Fatalf("replaced successor: %t %v", ok, err)
		}
		ok, err = dao.ReleaseArchiveStaging(ctx, original)
		if err != nil || !ok {
			t.Fatalf("release: %t %v", ok, err)
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		row, err := base.(store.SessionArchiveStagingDAO).ArchiveStagingRecord(ctx, id, original.FileID)
		if err != nil || row.State != "failed" || row.TerminalOffset != 4 || row.SuccessorFileID == "" || !row.StagingReleased || string(row.TerminalError) == "" {
			t.Fatalf("receipt not persisted: %+v %v", row, err)
		}
		return nil
	})
}

func TestArchiveStagingFinishCanceledQueryDoesNotPersist(t *testing.T) {
	db := isolatedStore(t)
	_, id := prepareArchiveSession(t, db)
	original := store.ArchiveStagingRecord{SessionID: id, FileID: uuid.NewString(), Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, Path: "history/original", TimelineRevision: 1}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		ok, err := base.(store.SessionArchiveStagingDAO).InsertArchiveStaging(t.Context(), original)
		if err != nil || !ok {
			t.Fatalf("register: %t %v", ok, err)
		}
		return nil
	})
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback cleanup: %v", err)
		}
	})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	ok, err := pgsession.New(tx).(store.SessionArchiveStagingDAO).FinishArchiveStaging(ctx, original, "complete", 8, nil)
	if err == nil || ok {
		t.Fatalf("canceled finish: %t %v", ok, err)
	}
	rollbackCtx, rollbackCancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = tx.Rollback(rollbackCtx)
	rollbackCancel()
	if err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("rollback canceled query: %v", err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		got, err := base.(store.SessionArchiveStagingDAO).ArchiveStagingRecord(t.Context(), id, original.FileID)
		if err != nil || got.State != "receiving" || got.TerminalOffset != 0 {
			t.Fatalf("canceled finish changed record: %+v %v", got, err)
		}
		return nil
	})
}

func TestArchiveStagingRecordsPersistAndLockOnlyCurrentVersionAndSession(t *testing.T) {
	db := isolatedStore(t)
	_, sessionID := prepareArchiveSessionForProject(t, db, 1)
	_, otherSessionID := prepareArchiveSessionForProject(t, db, 2)
	ctx := t.Context()
	failed := store.ArchiveStagingRecord{SessionID: sessionID, FileID: "10000000-0000-4000-8000-000000000001", Purpose: "history", SHA256: archiveHashOf("old"), ByteLength: 8, Path: "history/old", TimelineRevision: 7}
	resource := store.ArchiveStagingRecord{SessionID: sessionID, FileID: "20000000-0000-4000-8000-000000000002", Purpose: "resource", SHA256: archiveHashOf("resource"), ByteLength: 8, Path: "blobs/resource", TimelineRevision: 7, Resource: json.RawMessage(`{"name":"original","resourceId":"resource"}`)}
	other := store.ArchiveStagingRecord{SessionID: otherSessionID, FileID: uuid.NewString(), Purpose: "timeline", SHA256: archiveHashOf("other"), ByteLength: 5, Path: "timeline/other", TimelineRevision: 3}
	legacy := store.ArchiveBundleFile{SessionID: sessionID, FileID: uuid.NewString(), Purpose: "timeline", SHA256: archiveHashOf("legacy"), ByteLength: 6, AcceptedOffset: 6, State: "complete", Path: "timeline/legacy", TimelineRevision: 7}

	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveStagingDAO)
		for _, v := range []store.ArchiveStagingRecord{other, failed} {
			ok, err := dao.InsertArchiveStaging(ctx, v)
			if err != nil || !ok {
				t.Fatalf("insert %s: %t %v", v.FileID, ok, err)
			}
		}
		if err := base.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, legacy); err != nil {
			t.Fatal(err)
		}
		ok, err := dao.FinishArchiveStaging(ctx, failed, "failed", 4, json.RawMessage(`{"code":"staging_corrupt"}`))
		if err != nil || !ok {
			t.Fatalf("finish: %t %v", ok, err)
		}
		ok, err = dao.InsertArchiveStaging(ctx, resource)
		if err != nil || !ok {
			t.Fatalf("insert replacement: %t %v", ok, err)
		}
		ok, err = dao.SetArchiveStagingSuccessor(ctx, failed, resource.FileID)
		if err != nil || !ok {
			t.Fatalf("successor: %t %v", ok, err)
		}
		ok, err = dao.ReleaseArchiveStaging(ctx, failed)
		if err != nil || !ok {
			t.Fatalf("release: %t %v", ok, err)
		}
		return nil
	})

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	dao := pgsession.New(tx).(store.SessionArchiveStagingDAO)
	rows, err := dao.ArchiveStagingRecords(ctx, sessionID)
	if err != nil || len(rows) != 2 {
		t.Fatalf("list: %+v %v", rows, err)
	}
	var terminal struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rows[0].TerminalError, &terminal); err != nil || terminal.Code != "staging_corrupt" ||
		rows[0].SessionID != sessionID || rows[0].FileID != failed.FileID || rows[0].Purpose != failed.Purpose ||
		rows[0].SHA256 != failed.SHA256 || rows[0].ByteLength != failed.ByteLength || rows[0].Path != failed.Path ||
		rows[0].TimelineRevision != failed.TimelineRevision || rows[0].State != "failed" || rows[0].TerminalOffset != 4 ||
		rows[0].SuccessorFileID != resource.FileID || !rows[0].StagingReleased {
		t.Fatalf("persisted failed receipt: %+v error=%v", rows[0], err)
	}
	var descriptor map[string]string
	if err := json.Unmarshal(rows[1].Resource, &descriptor); err != nil ||
		rows[1].SessionID != sessionID || rows[1].FileID != resource.FileID || rows[1].Purpose != resource.Purpose ||
		rows[1].SHA256 != resource.SHA256 || rows[1].ByteLength != resource.ByteLength || rows[1].Path != resource.Path ||
		rows[1].TimelineRevision != resource.TimelineRevision || rows[1].State != "receiving" || rows[1].TerminalOffset != 0 ||
		rows[1].StagingReleased || rows[1].SuccessorFileID != "" || len(rows[1].TerminalError) != 0 ||
		descriptor["name"] != "original" || descriptor["resourceId"] != "resource" {
		t.Fatalf("persisted resource: %+v descriptor=%v err=%v", rows[1], descriptor, err)
	}
	if _, err := dao.ArchiveStagingRecord(ctx, sessionID, legacy.FileID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("legacy file included in v2 lookup: %v", err)
	}

	// The list transaction locks its own v2 rows but does not lock the v1 row
	// or another Session's upload. NOWAIT observes the actual database locks.
	for _, tc := range []struct {
		name, session, file string
		wantLocked          bool
	}{
		{"listed v2", sessionID, failed.FileID, true},
		{"legacy", sessionID, legacy.FileID, false},
		{"other session", otherSessionID, other.FileID, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			otherTx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer rollbackSessionTestTransaction(t, otherTx)
			var id string
			err = otherTx.QueryRow(ctx, `SELECT file_id::text FROM session_archive_files WHERE session_id=$1 AND file_id=$2 FOR UPDATE NOWAIT`, tc.session, tc.file).Scan(&id)
			if tc.wantLocked {
				var pgErr *pgconn.PgError
				if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
					t.Fatalf("expected row lock contention, got %v", err)
				}
			} else if err != nil || id != tc.file {
				t.Fatalf("unrelated row locked or missing: id=%q err=%v", id, err)
			}
		})
	}
}

func TestArchiveFileListsReturnCancellationWithoutPartialRows(t *testing.T) {
	db := isolatedStore(t)
	_, sessionID := prepareArchiveSession(t, db)
	for _, tc := range []struct {
		name string
		list func(context.Context, store.SessionDAO) (int, error)
	}{
		{"v1", func(ctx context.Context, dao store.SessionDAO) (int, error) {
			rows, err := dao.(store.SessionArchiveDAO).SessionArchiveFiles(ctx, sessionID)
			return len(rows), err
		}},
		{"v2", func(ctx context.Context, dao store.SessionDAO) (int, error) {
			rows, err := dao.(store.SessionArchiveStagingDAO).ArchiveStagingRecords(ctx, sessionID)
			return len(rows), err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx, err := db.Pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer rollbackSessionTestTransaction(t, tx)
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			count, err := tc.list(ctx, pgsession.New(tx))
			if err == nil || count != 0 {
				t.Fatalf("canceled list returned rows: count=%d err=%v", count, err)
			}
		})
	}
}
