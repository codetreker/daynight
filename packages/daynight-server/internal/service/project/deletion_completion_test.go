package project

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type deletionPreviewFailurePlan struct {
	projectValidationStore
	t       *testing.T
	ctx     context.Context
	id      string
	mode    string
	cause   error
	dao     *completionProjectReadPlan
	pending []string
	reads   int
}

func (d *deletionPreviewFailurePlan) ReadProjectDeletion(ctx context.Context, id string, work func(store.ProjectDeletionSnapshot) error) error {
	d.t.Helper()
	d.reads++
	if ctx != d.ctx || id != d.id || d.reads != 1 {
		d.t.Fatalf("unexpected deletion snapshot: reads=%d same context=%v id=%q want %q", d.reads, ctx == d.ctx, id, d.id)
	}
	if d.mode == "read" {
		return d.cause
	}
	err := work(d)
	if !errors.Is(err, d.cause) {
		d.t.Fatalf("deletion preview callback lost its %s failure: %v", d.mode, err)
	}
	return err
}

func (d *deletionPreviewFailurePlan) take(ctx context.Context, call string) {
	d.t.Helper()
	if ctx != d.ctx || len(d.pending) == 0 || call != d.pending[0] {
		d.t.Fatalf("unexpected deletion snapshot call %s: same context=%v pending=%v", call, ctx == d.ctx, d.pending)
	}
	if call != "ProjectDAO" && len(d.dao.pending) != 0 {
		d.t.Fatalf("deletion called %s before reading the Project: pending=%v", call, d.dao.pending)
	}
	d.pending = d.pending[1:]
}

func (d *deletionPreviewFailurePlan) ProjectDAO() store.ProjectReader {
	d.take(d.ctx, "ProjectDAO")
	return d.dao
}

func (d *deletionPreviewFailurePlan) ObservedAt(ctx context.Context) (time.Time, error) {
	d.take(ctx, "ObservedAt")
	if d.mode == "time" {
		return time.Time{}, d.cause
	}
	return time.Date(2026, 1, 2, 3, 5, 0, 0, time.UTC), nil
}

func (d *deletionPreviewFailurePlan) Summary(ctx context.Context) (store.ProjectDeletionSummary, error) {
	d.take(ctx, "Summary")
	if d.mode == "summary" {
		return store.ProjectDeletionSummary{}, d.cause
	}
	return store.ProjectDeletionSummary{TaskCount: 2, UnfinishedTaskCount: 1, AttachmentCount: 1}, nil
}

func (d *deletionPreviewFailurePlan) VisitTaskWorkers(ctx context.Context, visit func(store.ProjectDeletionWorker) error) error {
	d.take(ctx, "VisitTaskWorkers")
	if visit == nil {
		d.t.Fatal("deletion preview did not supply a Worker visitor")
	}
	return d.cause
}

type deletionResultStore struct {
	*completionProjectReadPlan
	projectID  string
	wantWrites int
	writes     int
	completion store.Completion
	cause      error
}

func (d *deletionResultStore) WriteProjectDeletion(ctx context.Context, id string, _ func(store.ProjectDeletionScope) error) (store.Completion, error) {
	d.t.Helper()
	d.writes++
	if d.writes > d.wantWrites || d.snapshots != 1 || len(d.pending) != 0 || ctx != d.ctx || id != d.projectID {
		d.t.Fatalf("unexpected deletion write: writes=%d want %d snapshots=%d same context=%v id=%q want %q pending=%v",
			d.writes, d.wantWrites, d.snapshots, ctx == d.ctx, id, d.projectID, d.pending)
	}
	return d.completion, d.cause
}

func requireDeletionFailure(t *testing.T, receipt DeletionReceipt, err error, outcome store.TransactionOutcome) *DeletionFailure {
	t.Helper()
	var failure *DeletionFailure
	if receipt != (DeletionReceipt{}) || !errors.As(err, &failure) || failure.Outcome != outcome || failure.Cause == nil {
		t.Fatalf("deletion returned receipt=%#v failure=%#v error=%v, want zero receipt and %s", receipt, failure, err, outcome)
	}
	return failure
}

func TestDeletionServiceCompletionAndReadFailures(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	project := projectPageItem(1, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	projectID := strings.ToUpper(project.ID)
	role := model.ProjectAdmin
	access := model.ProjectAccess{
		ProjectID: project.ID, UserID: actor.UserID, Role: role, TeamRole: &role, CanTransfer: true,
		OwnerTeam: model.TeamRef{ID: project.Ownership.TeamID, Kind: "personal"},
		Ownership: project.Ownership,
	}
	accessCall := completionProjectReadCall{name: "access", args: []any{actor, project.ID}, result: access}
	sentinel := errors.New("injected failure")
	page := model.PageRequest{Limit: 1}

	for _, test := range []struct {
		mode  string
		calls []string
	}{
		{"read", nil},
		{"time", []string{"ProjectDAO", "ObservedAt"}},
		{"summary", []string{"ProjectDAO", "ObservedAt", "Summary"}},
		{"workers", []string{"ProjectDAO", "ObservedAt", "Summary", "VisitTaskWorkers"}},
	} {
		t.Run(test.mode, func(t *testing.T) {
			ctx := t.Context()
			dao := &completionProjectReadPlan{t: t, ctx: ctx}
			if test.mode != "read" {
				dao.pending = []completionProjectReadCall{accessCall, {name: "project", args: []any{project.ID}, result: project}}
			}
			read := &deletionPreviewFailurePlan{
				t: t, ctx: ctx, id: project.ID, mode: test.mode, cause: sentinel, dao: dao, pending: test.calls,
			}
			result, err := NewProjects(read).DeletionPreview(ctx, actor, projectID, page)
			if !errors.Is(err, sentinel) || !reflect.DeepEqual(result, DeletionPreview{}) {
				t.Fatalf("deletion preview returned partial data or lost its cause: %#v, %v", result, err)
			}
			if read.reads != 1 || len(read.pending) != 0 || len(dao.pending) != 0 {
				t.Fatalf("incomplete preview read: reads=%d snapshot calls=%v DAO calls=%v", read.reads, read.pending, dao.pending)
			}
		})
	}

	t.Run("missing reader", func(t *testing.T) {
		result, err := NewProjects(projectValidationStore{}).DeletionPreview(t.Context(), actor, projectID, page)
		if err == nil || err.Error() != "project deletion reader unavailable" || !reflect.DeepEqual(result, DeletionPreview{}) {
			t.Fatalf("missing deletion reader: %#v, %v", result, err)
		}
	})
	t.Run("missing writer", func(t *testing.T) {
		ctx := t.Context()
		read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{accessCall})
		read.lifecycle = true
		receipt, err := NewProjects(read).Delete(ctx, actor, projectID)
		failure := requireDeletionFailure(t, receipt, err, store.TransactionNotCommitted)
		if failure.Cause.Error() != "project deletion dependencies unavailable" {
			t.Fatalf("missing writer cause: %v", failure.Cause)
		}
	})
	t.Run("nil engine", func(t *testing.T) {
		ctx := t.Context()
		read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{accessCall})
		read.lifecycle = true
		db := &deletionResultStore{completionProjectReadPlan: read, projectID: project.ID}
		receipt, err := NewProjects(db, nil).Delete(ctx, actor, projectID)
		failure := requireDeletionFailure(t, receipt, err, store.TransactionNotCommitted)
		if failure.Cause.Error() != "project deletion dependencies unavailable" {
			t.Fatalf("missing engine cause: %v", failure.Cause)
		}
	})
	t.Run("preflight read failure", func(t *testing.T) {
		ctx := t.Context()
		read := newCompletionProjectReadPlan(t, ctx, nil)
		read.lifecycle = true
		read.begin = sentinel
		db := &deletionResultStore{completionProjectReadPlan: read, projectID: project.ID}
		receipt, err := NewProjects(db).Delete(ctx, actor, projectID)
		requireDeletionFailure(t, receipt, err, store.TransactionNotCommitted)
		if !errors.Is(err, sentinel) {
			t.Fatalf("deletion lost its preflight failure: %v", err)
		}
	})

	for _, test := range []struct {
		name       string
		completion store.Completion
		cause      error
		want       store.TransactionOutcome
	}{
		{"operation", store.Completion{Outcome: store.TransactionNotCommitted}, sentinel, store.TransactionNotCommitted},
		{"commit unknown", store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: sentinel}, store.TransactionUnknown},
		{"cleanup failure", store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: sentinel}, store.TransactionUnknown},
		{"empty committed", store.Completion{Outcome: store.TransactionCommitted}, nil, store.TransactionUnknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{accessCall})
			read.lifecycle = true
			db := &deletionResultStore{
				completionProjectReadPlan: read, projectID: project.ID, wantWrites: 1,
				completion: test.completion, cause: test.cause,
			}
			receipt, err := NewProjects(db).Delete(ctx, actor, projectID)
			failure := requireDeletionFailure(t, receipt, err, test.want)
			if db.writes != 1 {
				t.Fatalf("deletion writes=%d, want 1", db.writes)
			}
			if test.cause != nil {
				if !errors.Is(err, test.cause) || !errors.Is(err, sentinel) {
					t.Fatalf("deletion lost its completion cause: %v", failure.Cause)
				}
			} else if failure.Cause.Error() != "project deletion did not produce a confirmed receipt" {
				t.Fatalf("deletion missing receipt cause: %v", failure.Cause)
			}
		})
	}

	validation := NewProjects(projectValidationStore{})
	receipt, err := validation.Delete(t.Context(), model.Principal{}, projectID)
	transferFault(t, err, "unauthenticated")
	if receipt != (DeletionReceipt{}) {
		t.Fatalf("unauthenticated deletion returned a receipt: %#v", receipt)
	}
	receipt, err = validation.Delete(t.Context(), actor, "bad")
	transferFault(t, err, "invalid_input")
	if receipt != (DeletionReceipt{}) {
		t.Fatalf("invalid Project deletion returned a receipt: %#v", receipt)
	}
}
