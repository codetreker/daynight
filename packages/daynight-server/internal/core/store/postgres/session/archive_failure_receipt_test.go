package session_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestArchiveFileFailureReceiptCompareAndPersist(t *testing.T) {
	db := isolatedStore(t)
	_, id := prepareArchiveSession(t, db)
	ctx := t.Context()
	original := json.RawMessage(`{"sourceEpoch":"original-source"}`)
	failure := json.RawMessage(`{"original":{"sourceEpoch":"original-source"},"failure":{"code":"quota_exceeded","message":"Session content capacity is exhausted."}}`)
	file := store.ArchiveBundleFile{SessionID: id, FileID: uuid.NewString(), Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, AcceptedOffset: 8, State: "receiving", Path: "history/original", TimelineRevision: 1, Resource: original}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		return base.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, file)
	})
	rollback := errors.New("reject transaction")
	completion, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
		base := scope.SessionDAO()
		if _, e := base.LockSession(ctx, id); e != nil {
			return e
		}
		if e := base.(store.SessionArchiveFailureDAO).FailSessionArchiveFile(ctx, file, failure); e != nil {
			return e
		}
		return rollback
	})
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("failure receipt rollback=%+v %v", completion, err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		got, e := base.(store.SessionArchiveDAO).SessionArchiveFile(ctx, id, file.FileID)
		if e != nil || got.State != "receiving" || !jsonEqualArchive(got.Resource, original) {
			t.Fatalf("rollback changed original: %+v %v", got, e)
		}
		return nil
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		wrong := file
		wrong.AcceptedOffset--
		if e := base.(store.SessionArchiveFailureDAO).FailSessionArchiveFile(ctx, wrong, failure); e == nil {
			t.Fatal("stale offset accepted")
		}
		wrong = file
		wrong.Resource = json.RawMessage(`{"sourceEpoch":"other"}`)
		if e := base.(store.SessionArchiveFailureDAO).FailSessionArchiveFile(ctx, wrong, failure); e == nil {
			t.Fatal("different source identity accepted")
		}
		return base.(store.SessionArchiveFailureDAO).FailSessionArchiveFile(ctx, file, failure)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		got, e := base.(store.SessionArchiveDAO).SessionArchiveFile(ctx, id, file.FileID)
		if e != nil || got.State != "failed" || !jsonEqualArchive(got.Resource, failure) {
			t.Fatalf("failure did not persist original identity and receipt: %+v %v", got, e)
		}
		if e = base.(store.SessionArchiveFailureDAO).FailSessionArchiveFile(ctx, file, failure); e == nil {
			t.Fatal("stale receiving state replaced failed receipt")
		}
		return nil
	})
}

func jsonEqualArchive(a, b []byte) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && fmtArchiveJSON(left) == fmtArchiveJSON(right)
}
func fmtArchiveJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
