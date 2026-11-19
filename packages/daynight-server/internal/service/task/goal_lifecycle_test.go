package task

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type lifecycleTestStore struct {
	store.ProjectWriter
	want context.Context
	typ  model.TaskType
	t    *testing.T
}

func (s lifecycleTestStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	if ctx != s.want {
		s.t.Fatal("type preflight changed caller context")
	}
	return run(lifecycleTestSnapshot{s: s})
}

type lifecycleTestSnapshot struct {
	store.SnapshotScope
	s lifecycleTestStore
}

func (s lifecycleTestSnapshot) ProjectDAO() store.ProjectReader { return lifecycleTestProject{s: s.s} }
func (s lifecycleTestSnapshot) TaskDAO() store.TaskReader       { return lifecycleTestTask{s: s.s} }

type lifecycleTestProject struct {
	store.ProjectReader
	s lifecycleTestStore
}

func (p lifecycleTestProject) ProjectAccess(ctx context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
	if ctx != p.s.want {
		p.s.t.Fatal("preflight authorization changed context")
	}
	return model.ProjectAccess{ProjectID: project, UserID: principal.UserID}, nil
}

type lifecycleTestTask struct {
	store.TaskReader
	s lifecycleTestStore
}

func (d lifecycleTestTask) TaskHeader(ctx context.Context, project, id string) (model.TaskHeader, error) {
	if ctx != d.s.want {
		d.s.t.Fatal("preflight header changed context")
	}
	return model.TaskHeader{ProjectID: project, ID: id, Type: d.s.typ}, nil
}

func TestGoalLifecycleBudgetStartsAfterTypeSelection(t *testing.T) {
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
	project := "33333333-3333-4333-8333-333333333333"
	id := "44444444-4444-4444-8444-444444444444"
	for _, typ := range []model.TaskType{model.TaskTypeTask, model.TaskTypeGoal} {
		t.Run(string(typ), func(t *testing.T) {
			ctx := t.Context()
			service := NewTasks(lifecycleTestStore{want: ctx, typ: typ, t: t})
			start := time.Now()
			actual, cancel, goal, err := service.lifecycleContext(ctx, principal, project, id)
			if err != nil {
				t.Fatal(err)
			}
			defer cancel()
			if goal != (typ == model.TaskTypeGoal) {
				t.Fatalf("wrong type: %v", goal)
			}
			if !goal {
				if actual != ctx {
					t.Fatal("ordinary Task deadline changed")
				}
				return
			}
			deadline, ok := actual.Deadline()
			if !ok || deadline.Before(start) || deadline.After(time.Now().Add(goalLifecycleTimeout)) {
				t.Fatalf("Goal write deadline: %v", deadline)
			}
		})
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	actual, done, _, err := NewTasks(lifecycleTestStore{want: ctx, typ: model.TaskTypeGoal, t: t}).lifecycleContext(ctx, principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	want, _ := ctx.Deadline()
	deadline, _ := actual.Deadline()
	if !deadline.Equal(want) {
		t.Fatal("Goal write extended caller deadline")
	}
}

func TestGoalLifecycleErrorPreservesCompletionFacts(t *testing.T) {
	cause := errors.New("commit transport failed")
	for _, test := range []struct {
		name    string
		goal    bool
		tx      store.TransactionError
		unknown bool
	}{
		{"unknown commit", true, store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}, true},
		{"unknown with cleanup", true, store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CommitAttempted: true, CleanupFailed: true, Cause: cause}, true},
		{"not committed", true, store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: cause}, false},
		{"cleanup without commit", true, store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: cause}, false},
		{"ordinary task", false, store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := goalLifecycleError(&test.tx, test.goal)
			var unknown *GoalWriteUnknown
			if errors.As(err, &unknown) != test.unknown || !errors.Is(err, cause) {
				t.Fatalf("lost transaction outcome or cause: %v", err)
			}
			var actual *store.TransactionError
			if !errors.As(err, &actual) || actual != &test.tx {
				t.Fatalf("lost transaction facts: %v", err)
			}
		})
	}
}
