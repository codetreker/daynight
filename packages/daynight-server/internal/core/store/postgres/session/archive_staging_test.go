package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
