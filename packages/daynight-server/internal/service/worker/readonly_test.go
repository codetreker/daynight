package worker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
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
	broker := NewReadOnly(db, rejectReadOnlyOAuth)
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
		b := NewReadOnly(uncertainReadOnlyStore{readOnlyStore: db, outcome: outcome}, rejectReadOnlyOAuth)
		_, err := b.Request(context.Background(), p, uuid.NewString(), readOnlyRequest())
		b.Close()
		if ro.ErrorCode(err) != "service_unavailable" {
			t.Fatal("unconfirmed authority admitted", err)
		}
	}
	failure := errors.New("identity database unavailable")
	b := NewReadOnly(uncertainReadOnlyStore{readOnlyStore: db, failure: failure}, rejectReadOnlyOAuth)
	defer b.Close()
	_, err := b.Request(context.Background(), p, uuid.NewString(), readOnlyRequest())
	if !errors.Is(err, failure) {
		t.Fatal("database failure hidden", err)
	}
}

func rejectReadOnlyOAuth(context.Context, model.Principal) error {
	return &model.Fault{Code: "unauthenticated", Message: "API access is not admitted in this fixture."}
}

type readOnlyIdentityDAO interface{ store.IdentityDAO }

type readOnlyAuthorityStore struct {
	readOnlyStore
	store.SnapshotScope
	store.WorkerReader
	store.IdentityScope
	readOnlyIdentityDAO
	t                           *testing.T
	owner, worker               string
	observed                    time.Time
	identityWrites, nativeLocks atomic.Int64
}

func (s *readOnlyAuthorityStore) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	s.identityWrites.Add(1)
	if err := fn(s); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (s *readOnlyAuthorityStore) IdentityDAO() store.IdentityDAO { return s }
func (s *readOnlyAuthorityStore) LockActivePAT(_ context.Context, user, id string, _ time.Time) (model.PersonalAccessToken, error) {
	s.nativeLocks.Add(1)
	if user != s.owner || id != "22222222-2222-4222-8222-222222222222" {
		s.t.Errorf("unexpected native PAT authority: %s/%s", user, id)
	}
	return model.PersonalAccessToken{}, nil
}
func (s *readOnlyAuthorityStore) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	return fn(s)
}
func (s *readOnlyAuthorityStore) ObservedAt(context.Context) (time.Time, error) {
	return s.observed, nil
}
func (s *readOnlyAuthorityStore) WorkerDAO() store.WorkerReader { return s }
func (s *readOnlyAuthorityStore) Worker(_ context.Context, user, worker string, observed time.Time) (model.WorkerSnapshot, error) {
	if worker != s.worker || observed != s.observed {
		s.t.Errorf("unexpected Worker observation: %s at %s", worker, observed)
	}
	if user != s.owner {
		return model.WorkerSnapshot{}, model.ErrNotFound
	}
	return model.WorkerSnapshot{WorkerID: worker, LastReportedAt: observed}, nil
}

type readOnlyContextPrincipal struct{}

func TestReadOnlyAPIRechecksOriginalRequesterAtEveryAdmission(t *testing.T) {
	type admissionCase struct {
		name        string
		stage       int
		failure     error
		transaction *store.TransactionError
		database    *store.Error
		cause       error
	}
	cases := []admissionCase{{name: "success"}}
	original := &store.TransactionError{Phase: "rollback", Outcome: store.TransactionNotCommitted, Cause: errors.New("credential cleanup failed")}
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.DeadlineExceeded}
	cleanup := &store.TransactionError{Phase: "rollback", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: context.Canceled}
	sql := &store.Error{Phase: "query", DatabaseFailure: true, SQLState: "08006", Cause: context.Canceled}
	for _, failure := range []admissionCase{
		{name: "original", transaction: original, failure: original, cause: original.Cause},
		{name: "unknown-deadline", transaction: unknown, failure: unknown, cause: context.DeadlineExceeded},
		{name: "cleanup-cancelled", transaction: cleanup, failure: errors.Join(model.Unauthenticated(model.ErrNotFound), cleanup), cause: context.Canceled},
		{name: "SQL-cancelled", database: sql, failure: errors.Join(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("operation rejected")}, sql), cause: context.Canceled},
	} {
		for stage := 1; stage <= 3; stage++ {
			c := failure
			c.name, c.stage = fmt.Sprintf("%s/stage-%d", failure.name, stage), stage
			c.failure = fmt.Errorf("API authority: %w", failure.failure)
			cases = append(cases, c)
		}
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			failedStage, failure := c.stage, c.failure
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			api := model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			producer := model.Principal{Kind: model.PATCredential, UserID: api.UserID, CredentialID: "22222222-2222-4222-8222-222222222222"}
			db := &readOnlyAuthorityStore{t: t, owner: api.UserID, worker: uuid.NewString(), observed: time.Now()}
			requestCtx := context.WithValue(ctx, readOnlyContextPrincipal{}, api)
			producerCtx := context.WithValue(ctx, readOnlyContextPrincipal{}, producer)
			var mu sync.Mutex
			calls := 0
			broker := NewReadOnly(db, func(callCtx context.Context, p model.Principal) error {
				mu.Lock()
				defer mu.Unlock()
				if p != api {
					t.Errorf("requester replaced: %+v", p)
				}
				if callCtx.Err() != nil {
					t.Errorf("admission context already ended: %v", callCtx.Err())
				}
				calls++
				wantContextPrincipal := api
				if calls == 2 {
					wantContextPrincipal = producer
				}
				if callCtx.Value(readOnlyContextPrincipal{}) != wantContextPrincipal {
					t.Errorf("stage %d did not use its original context", calls)
				}
				if calls == failedStage {
					return failure
				}
				return nil
			})
			defer broker.Close()
			connection, err := broker.Connect(ctx, producer, db.worker, ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := broker.Connect(ctx, api, db.worker, ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}}); ro.ErrorCode(err) != "permission_denied" {
				t.Fatalf("OAuth producer admitted: %v", err)
			}
			type result struct {
				message ro.Message
				err     error
			}
			answer := make(chan result, 1)
			go func() {
				message, err := broker.Request(requestCtx, api, db.worker, readOnlyRequest())
				answer <- result{message, err}
			}()
			if failedStage != 1 {
				select {
				case request := <-connection.Messages:
					request.Type, request.Input, request.Operation, request.TimeoutMs = "result", nil, "", 0
					request.Result = json.RawMessage(`{"path":"/repo","parentPath":null,"entries":[],"nextCursor":null}`)
					if err := broker.Deliver(producerCtx, connection, request); err != nil {
						t.Fatal(err)
					}
				case <-ctx.Done():
					t.Fatal("request was not dispatched", ctx.Err())
				}
			}
			select {
			case got := <-answer:
				if failedStage != 0 {
					if ctx.Err() != nil || !errors.Is(got.err, failure) || !errors.Is(got.err, c.cause) || len(got.message.Result) != 0 {
						t.Fatalf("API failure hidden with caller context %v: %+v", ctx.Err(), got)
					}
					var transaction *store.TransactionError
					if c.transaction != nil && (!errors.As(got.err, &transaction) || transaction != c.transaction || !errors.Is(got.err, c.transaction)) {
						t.Fatalf("transaction completion facts lost: %+v %v", transaction, got.err)
					}
					var database *store.Error
					if c.database != nil && (!errors.As(got.err, &database) || database != c.database || !errors.Is(got.err, c.database)) {
						t.Fatalf("SQL failure facts lost: %+v %v", database, got.err)
					}
					if code := ro.ErrorCode(got.err); code == "timeout" || code == "cancelled" {
						t.Fatalf("database failure normalized as caller interruption: %s %v", code, got.err)
					}
				} else if got.err != nil || string(got.message.Result) != `{"path":"/repo","parentPath":null,"entries":[],"nextCursor":null}` {
					t.Fatalf("API result = %+v", got)
				}
			case <-ctx.Done():
				t.Fatal("request did not finish", ctx.Err())
			}
			mu.Lock()
			wantCalls := failedStage
			if failedStage == 0 {
				wantCalls = 3
			}
			if calls != wantCalls {
				t.Errorf("API authority calls = %d, want %d", calls, wantCalls)
			}
			mu.Unlock()
			if err := broker.Check(ctx, connection); err != nil {
				t.Fatalf("API refusal affected shared PAT channel: %v", err)
			}
			go func() {
				message, err := broker.Request(ctx, producer, db.worker, readOnlyRequest())
				answer <- result{message, err}
			}()
			select {
			case request := <-connection.Messages:
				request.Type, request.Input, request.Operation, request.TimeoutMs = "result", nil, "", 0
				request.Result = json.RawMessage(`{"path":"/repo","parentPath":null,"entries":[],"nextCursor":null}`)
				if err := broker.Deliver(producerCtx, connection, request); err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("valid request on shared channel was not dispatched", ctx.Err())
			}
			select {
			case got := <-answer:
				if got.err != nil || len(got.message.Result) == 0 {
					t.Fatalf("valid request on shared channel failed: %+v", got)
				}
			case <-ctx.Done():
				t.Fatal("valid request on shared channel did not finish", ctx.Err())
			}
			if db.identityWrites.Load() != db.nativeLocks.Load() {
				t.Errorf("OAuth entered native identity transaction: %d writes, %d native locks", db.identityWrites.Load(), db.nativeLocks.Load())
			}
		})
	}
}
