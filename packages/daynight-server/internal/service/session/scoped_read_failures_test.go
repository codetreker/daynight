package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type scopedCheckerDAO struct {
	*scopeTestDAO
	taskErr, credentialErr, projectErr error
}

func (d scopedCheckerDAO) LockTask(ctx context.Context, p, t string) (store.SessionTask, error) {
	if d.taskErr != nil {
		return store.SessionTask{}, d.taskErr
	}
	return d.scopeTestDAO.LockTask(ctx, p, t)
}
func (d scopedCheckerDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	if d.credentialErr != nil {
		return d.credentialErr
	}
	return d.scopeTestDAO.LockCredential(ctx, p, now)
}
func (d scopedCheckerDAO) ProjectAccess(ctx context.Context, u, p string) (model.ProjectAccess, error) {
	if d.projectErr != nil {
		return model.ProjectAccess{}, d.projectErr
	}
	return d.scopeTestDAO.ProjectAccess(ctx, u, p)
}

type scopedCheckerScope struct {
	store.SessionScope
	dao store.SessionDAO
}

func (s scopedCheckerScope) SessionDAO() store.SessionDAO { return s.dao }
func (s scopedCheckerScope) BotDAO() store.BotWriteDAO    { return nil }

func TestScopedReadCheckerTaskAuthorizationAndFailures(t *testing.T) {
	allowed, denied := readPolicy(t, "session:read"), readPolicy(t, "task:read")
	failure := errors.New("authorization dependency failed")
	for _, scenario := range []string{"allowed", "scope removed", "missing scope", "missing checker", "invalid auth", "no task scope", "stopped", "task error", "current error", "changed actor", "credential error", "project error"} {
		t.Run(scenario, func(t *testing.T) {
			var calls []string
			dao := scopedCheckerDAO{scopeTestDAO: &scopeTestDAO{calls: &calls, task: store.SessionTask{Status: "in_progress"}}}
			switch scenario {
			case "task error":
				dao.taskErr = failure
			case "credential error":
				dao.credentialErr = failure
			case "project error":
				dao.projectErr = failure
			}
			scope := scopedCheckerScope{dao: dao}
			writer := archiveCompletionOrderWriter(func(_ context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				if err := run(scope); err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			})
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			svc := New(writer, engine)
			current := func(_ context.Context, got store.SessionScope, auth model.CredentialAuthorization) (model.CredentialAuthorization, error) {
				if got.SessionDAO() != dao {
					t.Fatal("wrong transaction")
				}
				switch scenario {
				case "current error":
					return model.CredentialAuthorization{}, failure
				case "changed actor":
					auth.Principal.CredentialID = "20000000-0000-4000-8000-000000000002"
				case "scope removed":
					return denied, nil
				}
				return auth, nil
			}
			checker := NewScopedReadChecker(svc, current)
			if scenario == "missing checker" {
				checker = nil
			}
			if scenario == "missing scope" {
				checker = NewScopedReadChecker(svc, nil)
			}
			auth := allowed
			if scenario == "invalid auth" {
				auth.Policy = nil
			}
			project, task := "project", "task"
			if scenario == "no task scope" {
				task = ""
			}
			if scenario == "stopped" {
				stopHistoryEngine(t, engine)
			}
			err := checker.CheckSessionRead(t.Context(), auth, project, task, "")
			switch scenario {
			case "allowed":
				if err != nil {
					t.Fatal(err)
				}
			case "scope removed":
				if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
					t.Fatal(err)
				}
			case "task error", "current error", "credential error", "project error":
				if !errors.Is(err, failure) {
					t.Fatalf("lost cause: %v", err)
				}
			default:
				if err == nil {
					t.Fatal("invalid request accepted")
				}
			}
		})
	}
}

func TestScopedCredentialReadDoesNotRunWorkOnRefusal(t *testing.T) {
	allowed, denied := readPolicy(t, "session:read"), readPolicy(t, "task:read")
	cause := errors.New("credential failed")
	for _, scenario := range []string{"allowed", "missing authorization source", "scope removed", "credential error"} {
		t.Run(scenario, func(t *testing.T) {
			var calls []string
			dao := scopedCheckerDAO{scopeTestDAO: &scopeTestDAO{calls: &calls}}
			if scenario == "credential error" {
				dao.credentialErr = cause
			}
			scope := scopedCheckerScope{dao: dao}
			writer := archiveCompletionOrderWriter(func(_ context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				if err := run(scope); err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			})
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			svc := New(writer, engine)
			var source SessionReadAuthorization
			if scenario != "missing authorization source" {
				source = func(context.Context, store.SessionScope, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
					if scenario == "scope removed" {
						return denied, nil
					}
					return allowed, nil
				}
			}
			ctx := WithScopedSessionRead(t.Context(), allowed, source, nil)
			called := false
			err := svc.credential(ctx, allowed.Principal, func(*core.Operation, store.SessionScope) error { called = true; return nil })
			if scenario == "allowed" {
				if err != nil || !called {
					t.Fatalf("allowed: %v", err)
				}
				return
			}
			if err == nil || called {
				t.Fatalf("refusal reached work: %v", err)
			}
			if scenario == "credential error" && !errors.Is(err, cause) {
				t.Fatal(err)
			}
			if scenario == "scope removed" && !errors.Is(err, scopepolicy.ErrInsufficientScope) {
				t.Fatal(err)
			}
		})
	}
}
