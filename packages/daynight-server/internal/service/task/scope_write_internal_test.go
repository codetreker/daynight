package task

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskWriteRedactionPreservesTransactionFacts(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:status"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	ctx := WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, false)
	fault := &model.Fault{Code: "dependency_unsatisfied", Message: "not ready", TaskIDs: []string{"private-task"}}
	safe := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}
	got := redactTaskWriteError(ctx, safe)
	if got.Error() != safe.Error() {
		t.Fatalf("error text changed: %q", got.Error())
	}
	var transaction *store.TransactionError
	var visible *model.Fault
	if !errors.As(got, &transaction) || transaction != safe || !errors.As(got, &visible) || visible.Code != fault.Code || len(visible.TaskIDs) != 0 {
		t.Fatalf("lost transaction facts or leaked IDs: %#v", got)
	}
	for _, unsafe := range []error{
		&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: fault},
		&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: fault},
		errors.Join(safe, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown}),
	} {
		if redactTaskWriteError(ctx, unsafe) != unsafe {
			t.Fatalf("changed unsafe transaction: %#v", unsafe)
		}
	}
}

type scopeAdmissionTestGoalDAO struct {
	store.GoalDependencyDAO
	lock func(context.Context) error
}

func (d scopeAdmissionTestGoalDAO) LockTeam(ctx context.Context) error { return d.lock(ctx) }

type scopeAdmissionTestTaskDAO struct {
	store.TaskWriteDAO
	header  func(context.Context, string) (model.TaskHeader, error)
	visible func(context.Context, string) (model.TaskHeader, error)
}

func (d scopeAdmissionTestTaskDAO) TaskHeader(ctx context.Context, id string) (model.TaskHeader, error) {
	return d.header(ctx, id)
}

func (d scopeAdmissionTestTaskDAO) TaskVisibilityHeader(ctx context.Context, id string) (model.TaskHeader, error) {
	return d.visible(ctx, id)
}

func TestScopedTaskAuthorizationLeavesTaskLocksToPlanner(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:delete"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, hidden := range []bool{false, true} {
		t.Run(fmt.Sprint(hidden), func(t *testing.T) {
			ctx := WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, false)
			ctx = withTaskWriteTarget(withTaskWriteOperations(ctx, scopepolicy.TaskDelete), "target", false)
			calls := 0
			dao := scopeAdmissionTestTaskDAO{visible: func(actual context.Context, id string) (model.TaskHeader, error) {
				calls++
				if actual != ctx || id != "target" {
					t.Fatal("nonlocking visibility changed identity")
				}
				if hidden {
					return model.TaskHeader{}, model.ErrTaskDeleted
				}
				return model.TaskHeader{ID: id}, nil
			}, header: func(context.Context, string) (model.TaskHeader, error) {
				t.Fatal("Task authorization acquired the locking Steps header")
				return model.TaskHeader{}, nil
			}}
			err := (&Tasks{}).authorizeTaskWrite(ctx, scopeAdmissionTestScope{task: dao}, principal)
			if calls != 1 || (hidden && !errors.Is(err, model.ErrTaskDeleted)) || (!hidden && err != nil) {
				t.Fatalf("visibility calls=%d hidden=%v error=%v", calls, hidden, err)
			}
		})
	}
}

type scopeAdmissionTestProjectDAO struct{ store.ProjectWriteDAO }

type scopeAdmissionTestScope struct {
	store.ProjectWriteScope
	goal    store.GoalDependencyDAO
	task    store.TaskWriteDAO
	project store.ProjectWriteDAO
}

func (s scopeAdmissionTestScope) GoalDependencyDAO() store.GoalDependencyDAO { return s.goal }
func (s scopeAdmissionTestScope) TaskDAO() store.TaskWriteDAO                { return s.task }
func (s scopeAdmissionTestScope) ProjectDAO() store.ProjectWriteDAO          { return s.project }

func TestScopedTaskWriteChecksVisibilityAndGoalLocks(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:status"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
	lockFailure, accessFailure, headerFailure := errors.New("team lock failed"), errors.New("project access failed"), errors.New("header read failed")
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name                          string
		goal                          bool
		lockErr, accessErr, headerErr error
		deleted                       bool
		want                          []string
		wantErr                       error
		fault                         string
	}{
		{"missing", false, nil, nil, model.ErrNotFound, false, []string{"header"}, nil, "not_found"},
		{"deleted error", false, nil, nil, model.ErrTaskDeleted, false, []string{"header"}, nil, "task_deleted"},
		{"deleted header", false, nil, nil, nil, true, []string{"header"}, nil, "task_deleted"},
		{"header failure", false, nil, nil, headerFailure, false, []string{"header"}, headerFailure, ""},
		{"goal lock failure", true, lockFailure, nil, nil, false, []string{"lock"}, lockFailure, ""},
		{"goal access failure", true, nil, accessFailure, nil, false, []string{"lock", "access"}, accessFailure, ""},
		{"goal succeeds", true, nil, nil, nil, false, []string{"lock", "access", "header"}, nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			ctx := WithTaskWriteAuthorization(t.Context(), auth, false)
			ctx = withTaskWriteTarget(withTaskWriteOperations(ctx, scopepolicy.TaskStatus), "task", tc.goal)
			goal := scopeAdmissionTestGoalDAO{lock: func(actual context.Context) error {
				if actual != ctx {
					t.Fatal("lock context changed")
				}
				calls = append(calls, "lock")
				return tc.lockErr
			}}
			tasks := scopeAdmissionTestTaskDAO{visible: func(actual context.Context, id string) (model.TaskHeader, error) {
				if actual != ctx || id != "task" {
					t.Fatal("header target or context changed")
				}
				calls = append(calls, "header")
				header := model.TaskHeader{ID: id}
				if tc.deleted {
					header.DeletedAt = &now
				}
				return header, tc.headerErr
			}}
			projects := scopeAdmissionTestProjectDAO{}
			scope := scopeAdmissionTestScope{goal: goal, task: tasks, project: projects}
			service := &Tasks{writeOperations: taskWriteOperations{requireProjectWrite: func(actual context.Context, dao store.ProjectWriteDAO, p model.Principal) (model.ProjectAccess, error) {
				if actual != ctx || dao != projects || p != principal {
					t.Fatal("project recheck changed inputs")
				}
				calls = append(calls, "access")
				return model.ProjectAccess{}, tc.accessErr
			}}}
			err := service.authorizeTaskWrite(ctx, scope, principal)
			if !reflect.DeepEqual(calls, tc.want) {
				t.Fatalf("calls %v, want %v", calls, tc.want)
			}
			if tc.fault != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != tc.fault {
					t.Fatalf("got %v, want %s", err, tc.fault)
				}
			} else if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("lost cause %v: %v", tc.wantErr, err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}
