package task

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func stepPolicy(t *testing.T, principal model.Principal, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	principal.Kind = model.PATCredential
	normalized, err := scopepolicy.Normalize(scopepolicy.PAT, ids)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, normalized, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedStepsReadRequiresReadAfterProjectAccess(t *testing.T) {
	f := newStepReadFixture(t, stepReadHeader(1))
	auth := stepPolicy(t, f.principal, "step:write")
	f.principal = auth.Principal
	f.svc.admit = NewScopedTaskSteps(&stepReadStore{f: f}).authorized(auth).admit
	f.begin("snapshot", "projectDAO", "authorize", "taskDAO", "header", "complete")
	_, err := f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
	f.end()
	stepReadFault(t, err, "insufficient_scope")

	denied := &model.Fault{Code: "forbidden", Message: "not a member"}
	f.authErr = denied
	f.begin("snapshot", "projectDAO", "authorize", "complete")
	_, err = f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
	f.end()
	if !errors.Is(err, denied) {
		t.Fatalf("project authorization lost: %v", err)
	}

	auth = stepPolicy(t, f.principal, "step:read")
	f.svc.admit = NewScopedTaskSteps(&stepReadStore{f: f}).authorized(auth).admit
	f.authErr = nil
	f.rows = []model.TaskStep{stepReadValue("00000000", 0)}
	f.begin(stepReadPath("rows")...)
	document, err := f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
	f.end()
	if err != nil || len(document.Resource.Steps) != 1 {
		t.Fatalf("read: %+v %v", document, err)
	}
}

func TestScopedStepsWriteRequiresWriteAndReadBeforeMutation(t *testing.T) {
	for _, ids := range [][]scopepolicy.ScopeID{{"step:read"}, {"step:write"}} {
		for _, name := range []string{"add", "update", "status", "move", "delete"} {
			t.Run(string(ids[0])+"/"+name, func(t *testing.T) {
				f := newStrictStepWrite(t, writeHeader(1), writeRows())
				auth := stepPolicy(t, f.principal, ids...)
				f.principal = auth.Principal
				f.svc.admit = NewScopedTaskSteps(f, f).authorized(auth).admit
				f.begin("store", "projectDAO", "authorize", "taskDAO", "header", "complete")
				var result StepsWriteResult
				var err error
				switch name {
				case "add":
					result, err = f.svc.Add(f.ctx, f.principal, f.projectID, f.taskID, AddTaskStep{Version: 1, ID: "abcdef12", Title: "new"})
				case "update":
					result, err = f.svc.Update(f.ctx, f.principal, f.projectID, f.taskID, "00000000", UpdateTaskStep{Version: 1, Title: stepWritePtr("new")})
				case "status":
					result, err = f.svc.SetStatus(f.ctx, f.principal, f.projectID, f.taskID, "00000000", SetTaskStepStatus{Version: 1, Status: model.TaskStepDone})
				case "move":
					result, err = f.svc.Move(f.ctx, f.principal, f.projectID, f.taskID, "00000000", MoveTaskStep{Version: 1, Position: stepWritePtr("last")})
				case "delete":
					result, err = f.svc.Delete(f.ctx, f.principal, f.projectID, f.taskID, "00000000", DeleteTaskStep{Version: 1})
				}
				f.end()
				stepReadFault(t, err, "insufficient_scope")
				if result.TransactionOutcome != store.TransactionNotCommitted || len(result.JSON) != 0 {
					t.Fatalf("result leaked or committed: %+v", result)
				}
			})
		}
	}
}

func TestScopedStepsMissingAndDeletedPrecedeScopeRefusal(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "deleted"}[deleted], func(t *testing.T) {
			r := newStepReadFixture(t, stepReadHeader(1))
			auth := stepPolicy(t, r.principal, "step:write")
			r.principal = auth.Principal
			r.svc.admit = NewScopedTaskSteps(&stepReadStore{f: r}).authorized(auth).admit
			if deleted {
				now := time.Now()
				r.header.DeletedAt = &now
			} else {
				r.headerErr = model.ErrNotFound
			}
			r.begin("snapshot", "projectDAO", "authorize", "taskDAO", "header", "complete")
			_, err := r.svc.List(r.ctx, r.principal, r.projectID, r.taskID)
			r.end()
			if deleted {
				stepReadFault(t, err, "task_deleted")
			} else {
				stepReadFault(t, err, "not_found")
			}
			w := newStrictStepWrite(t, writeHeader(1), writeRows())
			auth = stepPolicy(t, w.principal, "step:write")
			w.principal = auth.Principal
			w.svc.admit = NewScopedTaskSteps(w, w).authorized(auth).admit
			if deleted {
				now := time.Now()
				w.header.DeletedAt = &now
			} else {
				w.headerErr = model.ErrNotFound
			}
			w.begin("store", "projectDAO", "authorize", "taskDAO", "header", "complete")
			result, err := w.svc.Add(w.ctx, w.principal, w.projectID, w.taskID, AddTaskStep{Version: 1, ID: "abcdef12", Title: "new"})
			w.end()
			if deleted {
				stepReadFault(t, err, "task_deleted")
			} else {
				stepReadFault(t, err, "not_found")
			}
			if result.TransactionOutcome != store.TransactionNotCommitted {
				t.Fatalf("outcome: %+v", result)
			}
		})
	}
}
