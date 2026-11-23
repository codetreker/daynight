package worker

import (
	"context"
	"crypto/sha256"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type scopedReadOnlyStore struct {
	readOnlyAuthorityStore
	store.PATScopeDAO
	mu             sync.Mutex
	policies       map[string]*scopepolicy.Policy
	calls          map[string]int
	changeAtReturn bool
	lockedPAT      string
	transactionCtx context.Context
}

func (s *scopedReadOnlyStore) WriteIdentity(ctx context.Context, callback func(store.IdentityScope) error) (store.Completion, error) {
	s.transactionCtx = ctx
	defer func() { s.transactionCtx, s.lockedPAT = nil, "" }()
	if err := callback(s); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (s *scopedReadOnlyStore) IdentityDAO() store.IdentityDAO { return s }
func (s *scopedReadOnlyStore) LockActivePAT(ctx context.Context, owner, id string, _ time.Time) (model.PersonalAccessToken, error) {
	if owner != s.owner || ctx != s.transactionCtx || s.lockedPAT != "" {
		s.t.Fatalf("unexpected PAT validity lock: %s/%s", owner, id)
	}
	s.lockedPAT = id
	return model.PersonalAccessToken{}, nil
}
func (s *scopedReadOnlyStore) ReadLockedPATScope(ctx context.Context, owner, id string) (model.PersonalAccessToken, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if owner != s.owner || ctx != s.transactionCtx || s.lockedPAT != id {
		s.t.Fatalf("PAT policy read escaped its validity lock: %s/%s", owner, id)
	}
	s.calls[id]++
	policy, exists := s.policies[id]
	if !exists {
		s.t.Fatalf("unexpected PAT: %s", id)
	}
	if s.changeAtReturn && id == "33333333-3333-4333-8333-333333333333" && s.calls[id] == 3 {
		return model.PersonalAccessToken{ScopePolicy: readOnlyPolicy(s.t, "worker:read")}, nil
	}
	return model.PersonalAccessToken{ScopePolicy: policy}, nil
}
func readOnlyPolicy(t *testing.T, scopes ...scopepolicy.ScopeID) *scopepolicy.Policy {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return &policy
}

func TestScopedReadOnlyRechecksInspectionAndProducerSeparately(t *testing.T) {
	for _, stage := range []string{"success", "request", "delivery", "return", "producer"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			owner, worker := uuid.NewString(), uuid.NewString()
			producer := model.Principal{Kind: model.PATCredential, UserID: owner, CredentialID: "22222222-2222-4222-8222-222222222222"}
			requester := producer
			requester.CredentialID = "33333333-3333-4333-8333-333333333333"
			database := &scopedReadOnlyStore{
				readOnlyAuthorityStore: readOnlyAuthorityStore{t: t, owner: owner, worker: worker, observed: time.Now()},
				policies:               map[string]*scopepolicy.Policy{producer.CredentialID: readOnlyPolicy(t, "worker:report"), requester.CredentialID: readOnlyPolicy(t, "worker:inspect")},
				calls:                  map[string]int{}, changeAtReturn: stage == "return",
			}
			broker, err := NewScopedReadOnly(database, func(context.Context, model.Principal) error { t.Error("PAT used OAuth recheck"); return nil })
			if err != nil {
				t.Fatal(err)
			}
			defer broker.Close()
			connection, err := broker.Connect(ctx, producer, worker, ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
			if err != nil {
				t.Fatal(err)
			}
			if stage == "request" {
				database.policies[requester.CredentialID] = readOnlyPolicy(t, "worker:report")
				if result, err := broker.Request(ctx, requester, worker, readOnlyRequest()); ro.ErrorCode(err) != "insufficient_scope" || len(result.Result) != 0 {
					t.Fatalf("unauthorized request: %+v %v", result, err)
				}
				select {
				case <-connection.Messages:
					t.Fatal("unauthorized request dispatched")
				default:
				}
				return
			}
			type outcome struct {
				result ro.Message
				err    error
			}
			answer := make(chan outcome, 1)
			go func() {
				result, err := broker.Request(ctx, requester, worker, readOnlyRequest())
				answer <- outcome{result, err}
			}()
			var request ro.Message
			select {
			case request = <-connection.Messages:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			database.mu.Lock()
			if stage == "delivery" {
				database.policies[requester.CredentialID] = readOnlyPolicy(t, "worker:report")
			}
			if stage == "producer" {
				database.policies[producer.CredentialID] = readOnlyPolicy(t, "worker:inspect")
			}
			database.mu.Unlock()
			err = broker.Deliver(ctx, connection, ro.Message{Fence: request.Fence, Type: "result", RequestID: request.RequestID, Error: &ro.Error{Code: "not_found", Message: "missing"}})
			if stage == "producer" {
				if ro.ErrorCode(err) != "insufficient_scope" {
					t.Fatal("producer scope loss retained channel", err)
				}
				select {
				case <-connection.Done:
				default:
					t.Fatal("producer channel not closed")
				}
			} else if err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-answer:
				if stage == "success" {
					if got.err != nil || got.result.Error == nil {
						t.Fatalf("valid separated authority: %+v", got)
					}
				} else if got.err == nil || len(got.result.Result) != 0 || got.result.Error != nil {
					t.Fatalf("scope loss exposed result: %+v", got)
				}
				if (stage == "delivery" || stage == "return") && ro.ErrorCode(got.err) != "insufficient_scope" {
					t.Fatal(got.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestScopedReadOnlyRequiresAPIAuthority(t *testing.T) {
	if _, err := NewScopedReadOnly(nil, nil); err == nil {
		t.Fatal("missing current API authority accepted")
	}
}

func (s *scopedReadOnlyStore) LockSession(_ context.Context, principal model.Principal, _ time.Time) error {
	if principal.Kind != model.SessionCredential || principal.UserID != s.owner {
		s.t.Fatal("unexpected session authority", principal)
	}
	return nil
}

func TestScopedReadOnlyPreservesFixedProfilesAndRejectsMissingPATPolicy(t *testing.T) {
	owner, worker := uuid.NewString(), uuid.NewString()
	database := &scopedReadOnlyStore{readOnlyAuthorityStore: readOnlyAuthorityStore{t: t, owner: owner, worker: worker, observed: time.Now()}, policies: map[string]*scopepolicy.Policy{}, calls: map[string]int{}}
	apiCalls := 0
	broker, err := NewScopedReadOnly(database, func(_ context.Context, principal model.Principal) error {
		if principal.Kind != model.OAuthCredential || principal.UserID != owner {
			t.Fatal("wrong API authority", principal)
		}
		apiCalls++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.OAuthCredential} {
		principal := model.Principal{Kind: kind, UserID: owner, CredentialID: uuid.NewString()}
		if _, err := broker.Request(t.Context(), principal, worker, readOnlyRequest()); ro.ErrorCode(err) != "unsupported" {
			t.Fatal("fixed profile rejected", kind, err)
		}
	}
	if apiCalls != 1 {
		t.Fatal("API profile recheck not preserved", apiCalls)
	}
	pat := model.Principal{Kind: model.PATCredential, UserID: owner, CredentialID: uuid.NewString()}
	database.policies[pat.CredentialID] = nil
	if _, err := broker.Request(t.Context(), pat, worker, readOnlyRequest()); err == nil || ro.ErrorCode(err) == "unsupported" {
		t.Fatal("missing PAT policy admitted", err)
	}
}

func TestScopedReadOnlyRequiresPolicyStorageInsideValidityTransaction(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: "22222222-2222-4222-8222-222222222222"}
	database := &readOnlyAuthorityStore{t: t, owner: principal.UserID, worker: uuid.NewString(), observed: time.Now()}
	broker, err := NewScopedReadOnly(database, func(context.Context, model.Principal) error { t.Fatal("PAT used API authority"); return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	if _, err := broker.Request(t.Context(), principal, database.worker, readOnlyRequest()); err == nil || ro.ErrorCode(err) == "unsupported" {
		t.Fatal("missing scope storage admitted", err)
	}
	if database.nativeLocks.Load() != 1 {
		t.Fatal("scope storage bypassed validity lock", database.nativeLocks.Load())
	}
}

func TestScopedReadOnlyUsesPersistedPATScope(t *testing.T) {
	database := openWorkerIntegrationStore(t)
	owner := testsupport.ServicePrincipal(t, database)
	worker := uuid.NewString()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if _, err := NewWorkers(database).Report(ctx, owner, worker, serviceWorkerReport()); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(uuid.NewString()))
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: owner.UserID, Name: "scoped readonly", CreatedAt: time.Now(), TokenHash: hash[:], ScopePolicy: readOnlyPolicy(t, "worker:inspect")}
	if _, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, pat) }); err != nil {
		t.Fatal(err)
	}
	broker, err := NewScopedReadOnly(database, rejectReadOnlyOAuth)
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	caller := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: pat.ID}
	if _, err := broker.Request(ctx, caller, worker, readOnlyRequest()); ro.ErrorCode(err) != "unsupported" {
		t.Fatal("stored inspection scope not admitted", err)
	}
	if _, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		dao := scope.IdentityDAO().(store.PATScopeDAO)
		if _, err := dao.LockPATScope(ctx, owner.UserID, pat.ID); err != nil {
			return err
		}
		_, err := dao.ComparePATScope(ctx, owner.UserID, pat.ID, 1, []scopepolicy.ScopeID{"worker:report"}, time.Now())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Request(ctx, caller, worker, readOnlyRequest()); ro.ErrorCode(err) != "insufficient_scope" {
		t.Fatal("edited stored scope not rechecked", err)
	}
}
