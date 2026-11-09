package worker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func readOnlyRequest() ro.Request {
	return ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)}
}
func TestReadOnlyAuthorityUsesLiveOwnerCredentialsAndObservation(t *testing.T) {
	_, db, _, session := testsupport.ProjectService(t)
	ctx := context.Background()
	worker := uuid.NewString()
	if _, err := NewWorkers(db).Report(ctx, session, worker, serviceWorkerReport()); err != nil {
		t.Fatal(err)
	}
	broker := NewReadOnly(db)
	defer broker.Close()
	if _, err := broker.Request(ctx, session, worker, readOnlyRequest()); ro.ErrorCode(err) != "unsupported" {
		t.Fatal("valid owner not admitted", err)
	}
	other := testsupport.ServicePrincipal(t, db)
	if _, err := broker.Request(ctx, other, worker, readOnlyRequest()); ro.ErrorCode(err) != "not_found" {
		t.Fatal("other owner admitted", err)
	}
	hash := sha256.Sum256([]byte(uuid.NewString()))
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: session.UserID, Name: "read-only fixture", TokenHash: hash[:], CreatedAt: time.Now()}
	if _, err := db.WriteIdentity(ctx, func(s store.IdentityScope) error { return s.IdentityDAO().InsertPAT(ctx, pat) }); err != nil {
		t.Fatal(err)
	}
	workerPrincipal := model.Principal{UserID: session.UserID, CredentialID: pat.ID, Kind: model.PATCredential}
	connection, err := broker.Connect(ctx, workerPrincipal, worker, ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.WriteIdentity(ctx, func(s store.IdentityScope) error { return s.IdentityDAO().DeletePAT(ctx, session.UserID, pat.ID) }); err != nil {
		t.Fatal(err)
	}
	if err = broker.Check(ctx, connection); ro.ErrorCode(err) != "unauthenticated" {
		t.Fatal("revoked Worker PAT retained authority", err)
	}
	if _, err = db.Pool.Exec(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()-interval '121 seconds' WHERE worker_id=$1", worker); err != nil {
		t.Fatal(err)
	}
	if _, err = broker.Request(ctx, session, worker, readOnlyRequest()); ro.ErrorCode(err) != "offline" {
		t.Fatal("stale Worker admitted", err)
	}
	if _, err = db.Pool.Exec(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()+interval '1 hour' WHERE worker_id=$1", worker); err != nil {
		t.Fatal(err)
	}
	if _, err = broker.Request(ctx, session, worker, readOnlyRequest()); ro.ErrorCode(err) != "offline" {
		t.Fatal("future Worker admitted", err)
	}
	if _, err = NewWorkers(db).Report(ctx, session, worker, serviceWorkerReport()); err != nil {
		t.Fatal(err)
	}
	oauth := session
	oauth.Kind = model.OAuthCredential
	if _, err = broker.Request(ctx, oauth, worker, readOnlyRequest()); ro.ErrorCode(err) != "unauthenticated" {
		t.Fatal("unsupported credential admitted", err)
	}
	if _, err = db.WriteIdentity(ctx, func(s store.IdentityScope) error { return s.IdentityDAO().DeleteSession(ctx, session) }); err != nil {
		t.Fatal(err)
	}
	if _, err = broker.Request(ctx, session, worker, readOnlyRequest()); ro.ErrorCode(err) != "unauthenticated" {
		t.Fatal("logged-out session admitted", err)
	}
}

type uncertainReadOnlyStore struct {
	readOnlyStore
	outcome store.TransactionOutcome
	failure error
}

func (s uncertainReadOnlyStore) WriteIdentity(context.Context, func(store.IdentityScope) error) (store.Completion, error) {
	return store.Completion{Outcome: s.outcome}, s.failure
}
func TestReadOnlyAuthorityRequiresConfirmedDatabaseObservation(t *testing.T) {
	_, db, _, p := testsupport.ProjectService(t)
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		b := NewReadOnly(uncertainReadOnlyStore{readOnlyStore: db, outcome: outcome})
		_, err := b.Request(context.Background(), p, uuid.NewString(), readOnlyRequest())
		b.Close()
		if ro.ErrorCode(err) != "service_unavailable" {
			t.Fatal("unconfirmed authority admitted", err)
		}
	}
	failure := errors.New("identity database unavailable")
	b := NewReadOnly(uncertainReadOnlyStore{readOnlyStore: db, failure: failure})
	defer b.Close()
	_, err := b.Request(context.Background(), p, uuid.NewString(), readOnlyRequest())
	if !errors.Is(err, failure) {
		t.Fatal("database failure hidden", err)
	}
}
