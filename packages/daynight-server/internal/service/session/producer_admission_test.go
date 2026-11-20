package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const producerOwner = "11111111-1111-4111-8111-111111111111"
const grantParent = "22222222-2222-4222-8222-222222222222"
const connectionParent = "33333333-3333-4333-8333-333333333333"

type producerDAO struct {
	*scopeTestDAO
	invalid string
}

func (d *producerDAO) SessionLocationByGrant(context.Context, []byte) (store.SessionLocation, error) {
	return store.SessionLocation{SessionID: "session"}, nil
}
func (d *producerDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	if p.CredentialID == d.invalid {
		return model.ErrNotFound
	}
	return d.scopeTestDAO.LockCredential(ctx, p, now)
}

type producerScope struct{ dao *producerDAO }

func (s producerScope) SessionDAO() store.SessionDAO { return s.dao }
func (s producerScope) BotDAO() store.BotWriteDAO    { return nil }

type producerWriter struct{ scope producerScope }

func (w producerWriter) WriteSession(_ context.Context, f func(store.SessionScope) error) (store.Completion, error) {
	if err := f(w.scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestControllerGrantRechecksEachOriginalParent(t *testing.T) {
	for _, tc := range []struct {
		name, connection, denied, invalid string
		want                              []string
		success                           bool
	}{
		{"both authorized", connectionParent, "", "", []string{grantParent, connectionParent}, true},
		{"grant scope removed", connectionParent, grantParent, "", []string{grantParent}, false},
		{"connection scope removed", connectionParent, connectionParent, "", []string{grantParent, connectionParent}, false},
		{"connection revoked", connectionParent, "", connectionParent, []string{grantParent}, false},
		{"same parent checked once", grantParent, "", "", []string{grantParent}, true},
		{"missing retained parent", "", "", "", []string{grantParent}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var locks, checked []string
			expiry := time.Now().Add(time.Hour)
			dao := &producerDAO{scopeTestDAO: &scopeTestDAO{calls: &locks, record: store.SessionRecord{Owner: producerOwner, Parent: grantParent, ConnectionParent: tc.connection, GrantHash: []byte("grant"), GrantExpiry: &expiry, ConnectionExpiry: &expiry, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: "session", TestExecutionID: "test", ExecutionGeneration: "1"}}, Identity: sp.Identity{OwnerUserID: producerOwner}, Lifecycle: "active"}}}, invalid: tc.invalid}
			scope := producerScope{dao: dao}
			source := func(_ context.Context, got store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
				if got != scope || p.UserID != producerOwner || p.Kind != model.PATCredential {
					t.Fatalf("wrong scope or principal: %#v", p)
				}
				checked = append(checked, p.CredentialID)
				ids := []scopepolicy.ScopeID{"session:produce"}
				if p.CredentialID == tc.denied {
					ids = []scopepolicy.ScopeID{"session:read"}
				}
				policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
				if err != nil {
					t.Fatal(err)
				}
				return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}, nil
			}
			svc, err := NewScoped(producerWriter{scope}, core.NewEngine(nil), source)
			if err != nil {
				t.Fatal(err)
			}
			called := false
			err = svc.controllerGrant(t.Context(), []byte("grant"), func(*core.Access) error { called = true; return nil })
			if (err == nil) != tc.success || called != tc.success {
				t.Fatalf("err=%v called=%v", err, called)
			}
			if !reflect.DeepEqual(checked, tc.want) {
				t.Fatalf("checked %v want %v", checked, tc.want)
			}
			if tc.denied != "" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "insufficient_scope" {
					t.Fatalf("wrong scope error: %v", err)
				}
			}
		})
	}
}

func TestProducerRequiresOriginalScopedPAT(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: producerOwner, CredentialID: grantParent}
	svc, err := NewScoped(nil, core.NewEngine(nil), func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error) {
		return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = svc.requireProducer(t.Context(), nil, p); err == nil {
		t.Fatal("missing policy admitted")
	}
	if _, err = NewScoped(nil, core.NewEngine(nil), nil); err == nil {
		t.Fatal("missing source admitted")
	}
}

func (d *producerDAO) LockTaskRegistration(context.Context, string, string) (store.SessionTask, error) {
	return d.task, nil
}
func (d *producerDAO) FindTaskRegistration(context.Context, string, string, string, string) (string, error) {
	return "", model.ErrNotFound
}

func TestTaskRegistrationChecksActualCallerBeforeCreating(t *testing.T) {
	owner := model.Principal{Kind: model.PATCredential, UserID: producerOwner, CredentialID: grantParent}
	input := sp.Registration{ClaimID: "claim", WorkerID: "worker", WorktreeID: "worktree", Provider: "codex"}
	var calls []string
	dao := &producerDAO{scopeTestDAO: &scopeTestDAO{calls: &calls, task: store.SessionTask{Status: "in_progress", Type: model.TaskTypeTask, Worker: &model.WorkerClaim{ClaimID: "claim", WorkerID: "worker", WorktreeID: "worktree", UserID: producerOwner, State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb, Agent: model.WorkerAgent("codex")}}}}
	scope := producerScope{dao: dao}
	source := func(_ context.Context, got store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
		if got != scope || p != owner {
			t.Fatalf("wrong original caller: %#v", p)
		}
		policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:read"}, 1)
		if err != nil {
			t.Fatal(err)
		}
		return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}, nil
	}
	svc, err := NewScoped(producerWriter{scope}, core.NewEngine(nil), source)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	err = svc.registerTask(t.Context(), owner, "project", "task", input, func(*core.Operation, store.SessionScope, *core.Access) error { called = true; return nil })
	var f *model.Fault
	if called || !errors.As(err, &f) || f.Code != "insufficient_scope" {
		t.Fatalf("created=%v err=%v", called, err)
	}
}

func TestLegacyControllerGrantKeepsOriginalParentChecks(t *testing.T) {
	var locks []string
	expiry := time.Now().Add(time.Hour)
	dao := &producerDAO{scopeTestDAO: &scopeTestDAO{calls: &locks, record: store.SessionRecord{Owner: producerOwner, Parent: grantParent, ConnectionParent: connectionParent, GrantHash: []byte("grant"), GrantExpiry: &expiry, ConnectionExpiry: &expiry, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: "session", TestExecutionID: "test", ExecutionGeneration: "1"}}, Identity: sp.Identity{OwnerUserID: producerOwner}, Lifecycle: "active"}}}, invalid: connectionParent}
	svc := New(producerWriter{producerScope{dao: dao}}, core.NewEngine(nil))
	called := false
	if err := svc.controllerGrant(t.Context(), []byte("grant"), func(*core.Access) error { called = true; return nil }); err != nil || !called {
		t.Fatalf("legacy grant changed: called=%v err=%v", called, err)
	}
}

func TestProducerAdmissionRejectsUnusableAuthority(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: producerOwner, CredentialID: grantParent}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:produce"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	sourceErr := errors.New("authority unavailable")
	for _, tc := range []struct {
		name       string
		caller     model.Principal
		auth       model.CredentialAuthorization
		err        error
		wantSource bool
	}{
		{name: "source failure", caller: p, err: sourceErr, wantSource: true},
		{name: "different credential", caller: p, auth: model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: producerOwner, CredentialID: connectionParent}, Profile: model.ScopedPATProfile, Policy: &policy}, wantSource: true},
		{name: "wrong profile", caller: p, auth: model.CredentialAuthorization{Principal: p, Profile: model.SessionProfile}, wantSource: true},
		{name: "non PAT", caller: model.Principal{Kind: model.SessionCredential, UserID: producerOwner, CredentialID: grantParent}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			svc := &Service{producerAuthorization: func(_ context.Context, _ store.SessionScope, got model.Principal) (model.CredentialAuthorization, error) {
				called = true
				if got != tc.caller {
					t.Fatalf("wrong principal: %#v", got)
				}
				return tc.auth, tc.err
			}}
			err := svc.requireProducer(t.Context(), nil, tc.caller)
			if err == nil || called != tc.wantSource {
				t.Fatalf("unexpected result: err=%v source=%v", err, called)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("lost source error: %v", err)
			}
		})
	}
	if err := (&Service{}).requireProducer(t.Context(), nil, p); err != nil {
		t.Fatalf("legacy assembly changed: %v", err)
	}
}
