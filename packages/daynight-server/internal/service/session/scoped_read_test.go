package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func readPolicy(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedSessionReadRechecksWithinTaskTransaction(t *testing.T) {
	allowed, denied := readPolicy(t, "session:read"), readPolicy(t, "task:read")
	var calls []string
	dao := &scopeTestDAO{calls: &calls, task: store.SessionTask{Status: "in_progress"}}
	scope := scopeTestScope{dao: dao, bot: &scopeTestBot{calls: &calls}}
	engine := core.NewEngine(nil)
	t.Cleanup(func() { stopHistoryEngine(t, engine) })
	svc := New(scopeTestWriter{scope: scope}, engine)
	current := allowed
	resolver := func(ctx context.Context, actual store.SessionScope, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		if actual.SessionDAO() != dao || got.Principal != allowed.Principal {
			t.Fatal("credential read escaped transaction or changed actor")
		}
		calls = append(calls, "policy")
		return current, nil
	}
	ctx := WithScopedSessionRead(t.Context(), allowed, resolver, nil)
	ran := false
	read := func() error {
		return svc.taskReadQuery(ctx, allowed.Principal, "project", "task", func(*core.Operation, store.SessionScope, *core.TaskAccess, func(string) (*core.Access, error)) error {
			ran = true
			return nil
		})
	}
	if err := read(); err != nil || !ran {
		t.Fatalf("allowed read: %v, ran %v", err, ran)
	}
	if want := []string{"task", "policy", "credential:" + allowed.Principal.CredentialID, "project"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls %v, want %v", calls, want)
	}
	current = denied
	calls = nil
	ran = false
	if err := read(); !errors.Is(err, scopepolicy.ErrInsufficientScope) || ran {
		t.Fatalf("revoked read: %v, ran %v", err, ran)
	}
	if len(calls) != 4 {
		t.Fatalf("resource checks were not retained: %v", calls)
	}
}

func TestScopedSessionSubscriptionRechecksTestOwnershipAndScope(t *testing.T) {
	allowed, denied := readPolicy(t, "session:read"), readPolicy(t, "task:read")
	p := allowed.Principal
	var calls []string
	id := "session"
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, TestExecutionID: "test"}}, Identity: sp.Identity{OwnerUserID: p.UserID}, Lifecycle: "active"}
	dao := &scopeTestDAO{calls: &calls, record: store.SessionRecord{Snapshot: snapshot, Owner: p.UserID, Parent: "parent"}}
	scope := scopeTestScope{dao: dao, bot: &scopeTestBot{calls: &calls}}
	engine := core.NewEngine(nil)
	t.Cleanup(func() { stopHistoryEngine(t, engine) })
	svc := New(scopeTestWriter{scope: scope}, engine)
	current := allowed
	checker := NewScopedReadChecker(svc, func(ctx context.Context, s store.SessionScope, expected model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		if s.SessionDAO() != dao || expected.Principal != p {
			t.Fatal("wrong authority")
		}
		calls = append(calls, "policy")
		return current, nil
	})
	if err := checker.CheckSessionRead(t.Context(), allowed, "", "", id); err != nil {
		t.Fatal(err)
	}
	if want := []string{"association", "session", "policy", "credential:" + p.CredentialID, "credential:parent"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls %v, want %v", calls, want)
	}
	current = denied
	if err := checker.CheckSessionRead(t.Context(), allowed, "", "", id); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("revoked: %v", err)
	}
	dao.record.Owner = "other"
	if err := checker.CheckSessionRead(t.Context(), allowed, "", "", id); err == nil || errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("owner refusal must precede scope refusal: %v", err)
	}
}

func TestScopedSessionReadRejectsMissingSourceOrChangedActor(t *testing.T) {
	auth := readPolicy(t, "session:read")
	scope := scopeTestScope{}
	ctx := WithScopedSessionRead(t.Context(), auth, nil, nil)
	if _, err := readCheck(ctx, scope, auth.Principal); err == nil {
		t.Fatal("missing source accepted")
	}
	ctx = WithScopedSessionRead(t.Context(), auth, func(context.Context, store.SessionScope, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		other := auth
		other.Principal.CredentialID = "20000000-0000-4000-8000-000000000002"
		return other, nil
	}, nil)
	if _, err := readCheck(ctx, scope, auth.Principal); err == nil {
		t.Fatal("changed actor accepted")
	}
	if _, err := snapshotReadCheck(ctx, nil, auth.Principal); err == nil {
		t.Fatal("missing snapshot source accepted")
	}
}

func TestScopedInspectionRechecksAfterSampling(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	const session = "33333333-3333-4333-8333-333333333333"
	allowed, denied := readPolicy(t, "session:read"), readPolicy(t, "task:read")
	current := allowed
	reads, samples, policyReads := 0, 0, 0
	snapshot := inspectionSnapshot{session: inspectionSourceReader{read: func(context.Context, string, string, string) (store.TaskSessionSource, error) {
		reads++
		return store.TaskSessionSource{ProjectID: project, TaskID: task, Session: &store.TaskSessionStateSource{SessionID: session}}, nil
	}}}
	db := &inspectionStore{scope: snapshot}
	service := NewInspection(db, inspectionObserver(func(context.Context, model.Principal, store.TaskSessionSource) (sp.TaskSessionInspection, error) {
		samples++
		current = denied
		return sp.TaskSessionInspection{SessionID: session}, nil
	}))
	service.authorize = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
	service.projectRead = func(context.Context, store.ProjectReader, model.Principal, string) error { return nil }
	ctx := WithScopedSessionRead(t.Context(), allowed, nil, func(_ context.Context, got store.SnapshotScope, original model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		if got.SessionDAO() == nil || original.Principal != allowed.Principal {
			t.Fatal("wrong snapshot or actor")
		}
		policyReads++
		return current, nil
	})
	_, err := service.Inspect(ctx, allowed.Principal, project, task, session)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) || reads != 1 || samples != 1 || policyReads != 2 {
		t.Fatalf("read=%d samples=%d checks=%d err=%v", reads, samples, policyReads, err)
	}
}
