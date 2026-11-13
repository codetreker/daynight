package session

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

// This cross-boundary proof executes the Core decision on the real transaction-
// bound DAO. Store-owned tests separately verify the SQL and lock mechanisms.
func TestContentPublicationConcurrentPostgres(t *testing.T) {
	if os.Getenv("DAYNIGHT_TEST_DATABASE_URL") == "" {
		t.Skip("requires isolated PostgreSQL")
	}
	db := testutil.OpenStore(t, postgres.Open)
	_, actor, _ := testutil.AuthRecords(t, db)
	project := testutil.QueryProject(t, db.Pool, db, 1)
	task := testutil.QueryTask(t, db, project.ID, 2, model.TaskInProgress)
	id, claim := uuid.NewString(), uuid.NewString()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	_, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "active"}})
	})
	if err != nil {
		t.Fatal(err)
	}
	length, hash, mime := "10", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "image/png"
	firstResource := sp.Resource{ResourceID: uuid.NewString(), Revision: "1", Status: "available", Name: "image", ByteLength: &length, SHA256: &hash, MediaType: &mime}
	secondResource := firstResource
	secondResource.ResourceID = uuid.NewString()
	ledger := archiveLedger{HistoryID: uuid.NewString(), HistoryEpoch: "epoch", SourceThrough: "1", Entries: []archiveLedgerEntry{{ID: uuid.NewString(), Sequence: "1", Revision: "1", SHA256: hash, SourceSHA256: hash, ByteLength: int(MaxSessionContentBytes - 10000)}}, Occurrences: []archiveLedgerOccurrence{}}
	cost, err := checkContentReplacement(contentState{ledger: &ledger}, resourceContentChange{firstResource})
	if err != nil {
		t.Fatal(err)
	}
	ledger.Entries[0].ByteLength += int(MaxSessionContentBytes - cost.TimelineBytes - cost.IndexBytes - cost.ResourceBytes - cost.ResourceMetadataBytes)
	_, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if _, e := dao.LockSession(ctx, id); e != nil {
			return e
		}
		return dao.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "active", Revision: 1, Identity: []byte(`{}`), Resources: []byte(`[]`), Ledger: encode(ledger)})
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	dao1 := pgsession.New(first)
	if _, err = dao1.LockSession(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err = checkContentPublication(ctx, &operationTx{dao: dao1}, id, resourceContentChange{firstResource}); err != nil {
		t.Fatal(err)
	}
	if err = dao1.(store.SessionResourceDAO).InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: firstResource, BlobID: uuid.NewString(), BlobPath: "first"}); err != nil {
		t.Fatal(err)
	}
	second, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Rollback(context.Background())
	done := make(chan error, 1)
	go func() {
		dao2 := pgsession.New(second)
		_, e := dao2.LockSession(ctx, id)
		if e == nil {
			e = checkContentPublication(ctx, &operationTx{dao: dao2}, id, resourceContentChange{secondResource})
		}
		if e == nil {
			e = dao2.(store.SessionResourceDAO).InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: secondResource, BlobID: uuid.NewString(), BlobPath: "second"})
		}
		done <- e
	}()
	for {
		var blocked bool
		if err = db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2))`, first.Conn().PgConn().PID(), second.Conn().PgConn().PID()).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case e := <-done:
			t.Fatalf("second completed before first commit: %v", e)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err = first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var refusal *model.Fault
	if err = <-done; !errors.As(err, &refusal) || refusal.Code != "quota_exceeded" {
		t.Fatalf("second publication = %v", err)
	}
	if err = second.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	_, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		rows, e := scope.SessionDAO().(store.SessionResourceDAO).ListSessionResources(ctx, id)
		if e == nil && (len(rows) != 1 || rows[0].Resource.ResourceID != firstResource.ResourceID) {
			t.Fatalf("persisted resources = %+v", rows)
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
}
