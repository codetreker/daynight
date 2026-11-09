package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func TestArchiveInlineMigrationComparesOriginalAndRemovesInlineCopy(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	length, hash, mime := "8", archiveHashOf("original"), "text/plain"
	previous := store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "original", ByteLength: &length, SHA256: &hash, MediaType: &mime}}
	raw, _ := json.Marshal(previous.Resource)
	mustQueryExec(t, database, `INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,$3,$4)`, id, previous.Resource.ResourceID, raw, []byte("original"))
	next := previous
	next.BlobID, next.BlobPath, next.MigrationID = uuid.NewString(), "immutable/original", uuid.NewString()
	for _, kind := range []string{"descriptor", "migration", "blob-only", "path-only", "missing", "gc"} {
		t.Run(kind, func(t *testing.T) {
			stale := previous
			switch kind {
			case "descriptor":
				stale.Resource.Name = "replaced"
			case "migration":
				stale.MigrationID = uuid.NewString()
			case "blob-only":
				stale.BlobID = uuid.NewString()
			case "path-only":
				stale.BlobPath = "different/object"
			case "missing":
				stale.SessionID = uuid.NewString()
			case "gc":
				stale.GCPending = true
			}
			sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
				e := base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, stale, next)
				var fault *model.Fault
				if !errors.As(e, &fault) || fault.Code != "archive_conflict" {
					t.Fatal("changed conversion identity succeeded", kind, e)
				}
				return nil
			})
		})
	}
	for _, kind := range []string{"descriptor", "migration", "blob-only", "path-only", "external", "gc"} {
		t.Run("stored-"+kind, func(t *testing.T) {
			switch kind {
			case "descriptor":
				changed := previous.Resource
				changed.Name = "changed original"
				changedBytes, _ := json.Marshal(changed)
				mustQueryExec(t, database, `UPDATE session_resources SET descriptor=$3 WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, changedBytes)
			case "migration":
				mustQueryExec(t, database, `UPDATE session_resources SET migration_id=$3 WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, uuid.NewString())
			case "blob-only":
				mustQueryExec(t, database, `UPDATE session_resources SET blob_id=$3 WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, uuid.NewString())
			case "path-only":
				mustQueryExec(t, database, `UPDATE session_resources SET blob_path='changed/object' WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID)
			case "external":
				mustQueryExec(t, database, `UPDATE session_resources SET blob_id=$3,blob_path='changed/object' WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, uuid.NewString())
			case "gc":
				mustQueryExec(t, database, `UPDATE session_resources SET gc_pending=true WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID)
			}
			sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
				resources := base.(store.SessionResourceDAO)
				before, e := resources.SavedSessionResource(ctx, id, previous.Resource.ResourceID)
				if e != nil {
					return e
				}
				e = base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next)
				var fault *model.Fault
				if !errors.As(e, &fault) || fault.Code != "archive_conflict" {
					t.Fatal("changed stored original was converted", kind, e)
				}
				after, e := resources.SavedSessionResource(ctx, id, previous.Resource.ResourceID)
				if e == nil && !reflect.DeepEqual(before, after) {
					t.Fatal("refused conversion changed its stored original", kind, before, after)
				}
				return e
			})
			var content []byte
			if e := database.Pool.QueryRow(ctx, `SELECT content FROM session_resources WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID).Scan(&content); e != nil || string(content) != "original" {
				t.Fatal("refused conversion lost inline original bytes", kind, content, e)
			}
			mustQueryExec(t, database, `UPDATE session_resources SET descriptor=$3,blob_id=NULL,blob_path=NULL,migration_id=NULL,gc_pending=false WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, raw)
		})
	}
	rejected := errors.New("reject conversion transaction")
	completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
		if e := scope.SessionDAO().(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next); e != nil {
			return e
		}
		return rejected
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(e, rejected) {
		t.Fatal("conversion rollback outcome", completion, e)
	}
	var retained []byte
	if e := database.Pool.QueryRow(ctx, `SELECT content FROM session_resources WHERE session_id=$1 AND resource_id=$2 AND blob_id IS NULL AND blob_path IS NULL`, id, previous.Resource.ResourceID).Scan(&retained); e != nil || string(retained) != "original" {
		t.Fatal("rolled back conversion lost its inline original", retained, e)
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		return base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next)
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		saved, e := base.(store.SessionResourceDAO).SavedSessionResource(ctx, id, previous.Resource.ResourceID)
		if e != nil || !reflect.DeepEqual(saved, next) {
			t.Fatal("external conversion did not preserve the resource", saved, e)
		}
		if e = base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next); e == nil {
			t.Fatal("stale conversion overwrote an external original")
		}
		return nil
	})
	var content []byte
	if e := database.Pool.QueryRow(ctx, `SELECT content FROM session_resources WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID).Scan(&content); e != nil || content != nil {
		t.Fatal("conversion retained a second inline copy", content, e)
	}
}

func TestArchiveConnectionEpochAndConsumedGrantCommitTogether(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	fileID := uuid.NewString()
	bundle := store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "active", Revision: 9, Identity: json.RawMessage(`{"controller":"original"}`), Resources: json.RawMessage(`[]`), Ledger: json.RawMessage(`{"HistoryEpoch":"original","HistoryID":"` + fileID + `","Entries":[]}`), HistoryID: fileID}
	file := store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, AcceptedOffset: 4, State: "receiving", Path: "original/round"}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		if e := base.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		return base.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, file)
	})
	for _, commit := range []bool{false, true} {
		tx, e := database.Pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		func() {
			defer tx.Rollback(context.Background())
			dao := pgsession.New(tx)
			r, e := dao.LockSession(ctx, id)
			if e != nil {
				t.Fatal(e)
			}
			changed := bundle
			changed.Ledger = json.RawMessage(`{"HistoryEpoch":"original","FinalHistoryEpoch":"connected","HistoryID":"` + fileID + `","Entries":[]}`)
			if e = dao.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, changed); e != nil {
				t.Fatal(e)
			}
			r.Snapshot.HistoryEpoch = "connected"
			if e = dao.ConnectSession(ctx, id, uuid.NewString(), time.Now(), nil); e != nil {
				t.Fatal(e)
			}
			if e = dao.SaveSession(ctx, r); e != nil {
				t.Fatal(e)
			}
			if commit {
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
			}
		}()
		sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
			r, e := base.LockSession(ctx, id)
			if e != nil {
				return e
			}
			saved, e := base.(store.SessionArchiveDAO).SessionArchiveBundle(ctx, id)
			if e != nil {
				return e
			}
			var ledger map[string]any
			_ = json.Unmarshal(saved.Ledger, &ledger)
			if commit != r.Consumed || commit != (r.Snapshot.HistoryEpoch == "connected") || commit != (ledger["FinalHistoryEpoch"] == "connected") || saved.HistoryID != fileID || saved.Revision != bundle.Revision {
				t.Fatal("connection partially published its archive handoff", commit, r.Consumed, r.Snapshot.HistoryEpoch, saved)
			}
			storedFile, e := base.(store.SessionArchiveDAO).SessionArchiveFile(ctx, id, fileID)
			if e != nil || storedFile.State != file.State || storedFile.AcceptedOffset != file.AcceptedOffset {
				t.Fatal("epoch handoff replaced the partial file receipt", storedFile, e)
			}
			return nil
		})
	}
}
