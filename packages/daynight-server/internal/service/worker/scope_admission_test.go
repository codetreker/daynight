package worker

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type workerAuthorization struct {
	read   func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error)
	write  func(context.Context, store.WorkerScope, model.Principal) (model.CredentialAuthorization, error)
	prompt func(context.Context, store.PromptSnapshot, model.Principal) (model.CredentialAuthorization, error)
}

func (s workerAuthorization) Read(ctx context.Context, scope store.SnapshotScope, principal model.Principal) (model.CredentialAuthorization, error) {
	return s.read(ctx, scope, principal)
}
func (s workerAuthorization) WorkerWrite(ctx context.Context, scope store.WorkerScope, principal model.Principal) (model.CredentialAuthorization, error) {
	return s.write(ctx, scope, principal)
}
func (s workerAuthorization) PromptRead(ctx context.Context, scope store.PromptSnapshot, principal model.Principal) (model.CredentialAuthorization, error) {
	return s.prompt(ctx, scope, principal)
}
func workerPolicy(t *testing.T, principal model.Principal, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	canonical, err := scopepolicy.Normalize(scopepolicy.PAT, scopes)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, canonical, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
}

type admissionSnapshot struct{ store.SnapshotScope }

type configurationAdmissionSnapshot struct {
	store.SnapshotScope
	reader store.WorkerReader
}

func (s *configurationAdmissionSnapshot) WorkerDAO() store.WorkerReader { return s.reader }

type configurationAdmissionReader struct {
	store.WorkerReader
	t         *testing.T
	principal model.Principal
	workerID  string
}

func (r configurationAdmissionReader) WorkerConfiguration(ctx context.Context, userID, workerID string) (model.WorkerConfigurationResource, error) {
	if ctx != r.t.Context() || userID != r.principal.UserID || workerID != r.workerID {
		r.t.Fatal("configuration read binding mismatch")
	}
	return model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "7"}, ObservationRevision: "3"}, nil
}

type scopeAdmissionStore struct {
	snapshot      store.SnapshotScope
	writeScope    store.WorkerScope
	reads, writes int
}

func (s *scopeAdmissionStore) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.reads++
	return operation(s.snapshot)
}
func (s *scopeAdmissionStore) WriteWorker(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
	s.writes++
	err := operation(s.writeScope)
	return store.Completion{Outcome: store.TransactionNotCommitted}, err
}

func TestScopedWorkersRefuseBeforeDomainAccess(t *testing.T) {
	executionCtx := t.Context()
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	for _, tc := range []struct {
		name  string
		write bool
		call  func(*Workers) error
	}{
		{"list", false, func(s *Workers) error {
			_, err := s.List(t.Context(), principal, model.PageRequest{Limit: 10})
			return err
		}},
		{"get", false, func(s *Workers) error { _, err := s.Get(t.Context(), principal, id); return err }},
		{"alias", false, func(s *Workers) error { _, err := s.Alias(t.Context(), principal, id); return err }},
		{"review participation", false, func(s *Workers) error { _, err := s.ReviewParticipation(t.Context(), principal, id); return err }},
		{"review candidates", false, func(s *Workers) error {
			_, err := s.ReviewPullRequests(t.Context(), principal, id, model.PageRequest{Limit: 10})
			return err
		}},
		{"monitoring", false, func(s *Workers) error { _, err := s.GetMonitoring(t.Context(), principal, id); return err }},
		{"monitoring query", false, func(s *Workers) error { _, err := s.QueryMonitoring(t.Context(), principal, []string{id}); return err }},
		{"report", true, func(s *Workers) error {
			report := serviceWorkerReport()
			report.TaskInventory = nil
			_, err := s.Report(t.Context(), principal, id, report)
			return err
		}},
		{"put alias", true, func(s *Workers) error {
			value := "alias"
			_, err := s.PutAlias(t.Context(), principal, id, "1", &value)
			return err
		}},
		{"put participation", true, func(s *Workers) error {
			_, err := s.PutReviewParticipation(t.Context(), principal, id, "1", true)
			return err
		}},
		{"put configuration", true, func(s *Workers) error {
			_, err := s.PutConfiguration(t.Context(), principal, id, "1", cloudWorkerConfiguration(""))
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snapshot := &admissionSnapshot{}
			writeScope := &syncScope{}
			database := &scopeAdmissionStore{snapshot: snapshot, writeScope: writeScope}
			authorityCalls := 0
			source := workerAuthorization{
				read: func(ctx context.Context, got store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
					authorityCalls++
					if tc.write || got != snapshot || p != principal || ctx != executionCtx {
						t.Fatal("incorrect read authorization binding")
					}
					return workerPolicy(t, principal, "prompt:read"), nil
				},
				write: func(ctx context.Context, got store.WorkerScope, p model.Principal) (model.CredentialAuthorization, error) {
					authorityCalls++
					if !tc.write || got != writeScope || p != principal || ctx != executionCtx {
						t.Fatal("incorrect write authorization binding")
					}
					return workerPolicy(t, principal, "prompt:read"), nil
				},
			}
			workers, err := NewScopedWorkers(database, source)
			if err != nil {
				t.Fatal(err)
			}
			if err := tc.call(workers); !errors.Is(err, scopepolicy.ErrInsufficientScope) || authorityCalls != 1 {
				t.Fatalf("err=%v calls=%d", err, authorityCalls)
			}
		})
	}
}

type scopedPromptStore struct {
	*syncStore
	snapshot store.PromptSnapshot
}

func (s *scopedPromptStore) ReadPromptSnapshot(ctx context.Context, operation func(store.PromptSnapshot) error) error {
	if !s.committed {
		panic("prompt authorization before commit")
	}
	s.reads++
	return operation(s.snapshot)
}

type emptyPromptSnapshot struct{ store.PromptSnapshot }

func TestScopedReportSyncPreservesCommitWhenPromptReadIsRemoved(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	database := &scopedPromptStore{syncStore: &syncStore{outcome: store.TransactionCommitted}, snapshot: &emptyPromptSnapshot{}}
	report := serviceWorkerReport()
	report.TaskInventory = nil
	report.Configuration = &model.WorkerConfigurationExchange{}
	writeCalls, promptCalls := 0, 0
	source := workerAuthorization{
		write: func(ctx context.Context, scope store.WorkerScope, p model.Principal) (model.CredentialAuthorization, error) {
			writeCalls++
			if p != principal || scope == nil {
				t.Fatal("incorrect report authority")
			}
			return workerPolicy(t, p, "worker:report", "worker:read", "prompt:read"), nil
		},
		prompt: func(ctx context.Context, scope store.PromptSnapshot, p model.Principal) (model.CredentialAuthorization, error) {
			promptCalls++
			if !database.committed || scope != database.snapshot || p != principal {
				t.Fatal("incorrect post-commit authority")
			}
			return workerPolicy(t, p, "worker:report", "worker:read"), nil
		},
	}
	workers, err := NewScopedWorkersWithPrompts(database, database, source)
	if err != nil {
		t.Fatal(err)
	}
	selectors := []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}}, {Key: model.PromptKey{Scope: model.PromptScopeWorker}}}
	result, err := workers.ReportSync(t.Context(), principal, uuid.NewString(), report, selectors)
	if err != nil || writeCalls != 1 || promptCalls != 1 || !database.committed || result.Native.LastReportedAt.Unix() != 41 || result.Native.Configuration == nil || len(result.Prompts) != len(selectors) {
		t.Fatalf("result=%+v err=%v write=%d prompt=%d", result, err, writeCalls, promptCalls)
	}
	for i, item := range result.Prompts {
		if item.Key != selectors[i].Key || item.Status != "error" || item.Error != "unavailable" || item.Value != nil || item.Revision != "" {
			t.Fatalf("leaked prompt result %+v", item)
		}
	}
}

func TestScopedWorkersRequireSourceAndBoundPrincipal(t *testing.T) {
	if _, err := NewScopedWorkers(nil, nil); err == nil {
		t.Fatal("nil authorization admitted")
	}
	if _, err := NewScopedWorkersWithPrompts(nil, nil, workerAuthorization{}); err == nil {
		t.Fatal("nil prompt reader admitted")
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	authorization := workerPolicy(t, principal, "worker:read")
	authorization.Principal.CredentialID = uuid.NewString()
	if err := requireAuthorization(principal, authorization, nil, scopepolicy.WorkerRead); err == nil {
		t.Fatal("mismatched principal admitted")
	}
	failure := errors.New("authority unavailable")
	if err := requireAuthorization(principal, authorization, failure, scopepolicy.WorkerRead); err != failure {
		t.Fatal(err)
	}
	if NewWorkers(nil).ScopesEnabled() {
		t.Fatal("legacy worker advertises scoped admission")
	}
}

func TestScopedConfigurationSuppressesExistingProjectionWithoutRead(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	for _, allowed := range []bool{false, true} {
		snapshot := &configurationAdmissionSnapshot{reader: configurationAdmissionReader{t: t, principal: principal, workerID: id}}
		database := &scopeAdmissionStore{snapshot: snapshot}
		calls := 0
		workers, err := NewScopedWorkers(database, workerAuthorization{read: func(ctx context.Context, scope store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
			calls++
			if scope != snapshot || p != principal || ctx != t.Context() {
				t.Fatal("configuration authority binding mismatch")
			}
			if allowed {
				return workerPolicy(t, p, "worker:read"), nil
			}
			return workerPolicy(t, p, "worker:configure"), nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		result, err := workers.Configuration(t.Context(), principal, id)
		if allowed {
			if err != nil || result.Desired == nil || result.Desired.Revision != "7" || result.ObservationRevision != "3" {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		} else if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result.Desired != nil || result.ObservationRevision != "" {
			t.Fatalf("result=%+v err=%v", result, err)
		}
		if calls != 1 {
			t.Fatalf("authority calls=%d", calls)
		}
	}
}

func TestScopedReportSeparatesReportProjectionAndDesiredWrite(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	for _, tc := range []struct {
		name                              string
		scopes                            []scopepolicy.ScopeID
		configuration, bootstrap, refused bool
	}{
		{"minimal report", []scopepolicy.ScopeID{"worker:report"}, false, false, false},
		{"read cannot report", []scopepolicy.ScopeID{"worker:read"}, false, false, true},
		{"full receipt requires read", []scopepolicy.ScopeID{"worker:report"}, true, false, true},
		{"unchanged exchange", []scopepolicy.ScopeID{"worker:report", "worker:read"}, true, false, false},
		{"bootstrap requires configure", []scopepolicy.ScopeID{"worker:report", "worker:read"}, true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database := &syncStore{outcome: store.TransactionCommitted}
			workers, err := NewScopedWorkers(database, workerAuthorization{write: func(ctx context.Context, scope store.WorkerScope, p model.Principal) (model.CredentialAuthorization, error) {
				return workerPolicy(t, p, tc.scopes...), nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			report := serviceWorkerReport()
			report.TaskInventory = nil
			if tc.configuration {
				report.Configuration = &model.WorkerConfigurationExchange{}
			}
			if tc.bootstrap {
				value := cloudWorkerConfiguration("")
				report.Configuration.Bootstrap = &value
			}
			result, err := workers.Report(t.Context(), principal, uuid.NewString(), report)
			if tc.refused {
				if !errors.Is(err, scopepolicy.ErrInsufficientScope) || database.committed || result.Configuration != nil || !result.LastReportedAt.IsZero() {
					t.Fatalf("result=%+v err=%v committed=%v", result, err, database.committed)
				}
			} else if err != nil || !database.committed || result.LastReportedAt.Unix() != 41 || (result.Configuration != nil) != tc.configuration {
				t.Fatalf("result=%+v err=%v committed=%v", result, err, database.committed)
			}
		})
	}
}
