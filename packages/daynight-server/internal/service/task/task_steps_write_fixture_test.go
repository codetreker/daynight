package task_test

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type stepWriteCapture struct {
	taskMockBase
	CaptureBatchFn func(context.Context, store.WebhookCaptureDAO, []protocol.Fact) error
}

func (capture *stepWriteCapture) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	capture.need("CaptureBatch", capture.CaptureBatchFn != nil)
	return capture.CaptureBatchFn(ctx, dao, facts)
}

type stepWriteFixture struct {
	T         *testing.T
	Ctx       context.Context
	Principal model.Principal
	Header    model.TaskHeader
	Current   []model.TaskStep
	Writer    *taskWriterMock
	Project   *projectWriterMock
	Scope     *taskProjectScopeMock
	Store     *taskStoreMock
	Capture   *stepWriteCapture
	Steps     *taskservice.TaskSteps
}

func newStepWriteFixture(t *testing.T, header model.TaskHeader, current []model.TaskStep, outcome store.TransactionOutcome) *stepWriteFixture {
	t.Helper()
	base := newTaskMockBase(t, "steps")
	f := &stepWriteFixture{T: t, Ctx: t.Context(), Header: header, Current: current,
		Principal: model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}}
	f.Writer = &taskWriterMock{taskMockBase: base.withLabel("task")}
	f.Project = &projectWriterMock{taskMockBase: base.withLabel("project")}
	f.Scope = &taskProjectScopeMock{taskMockBase: base.withLabel("scope")}
	f.Store = &taskStoreMock{taskMockBase: base.withLabel("store")}
	f.Capture = &stepWriteCapture{taskMockBase: base.withLabel("capture")}
	f.Scope.ProjectDAOFn = func() store.ProjectWriteDAO { return f.Project }
	f.Scope.TaskDAOFn = func() store.TaskWriteDAO { return f.Writer }
	f.Project.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
		if ctx != f.Ctx || p != f.Principal {
			t.Fatal("Step write changed authorization context or principal")
		}
		return model.ProjectAccess{ProjectID: f.Header.ProjectID, UserID: p.UserID, Role: model.ProjectMemberRole}, nil
	}
	f.Writer.TaskHeaderFn = func(ctx context.Context, id string) (model.TaskHeader, error) {
		if ctx != f.Ctx || id != f.Header.ID {
			t.Fatal("Step write changed parent identity or context")
		}
		return f.Header, nil
	}
	f.Writer.TaskStepsFn = func(ctx context.Context, id string) ([]model.TaskStep, error) {
		if ctx != f.Ctx || id != f.Header.ID {
			t.Fatal("Step write changed collection identity or context")
		}
		return f.Current, nil
	}
	f.Store.WriteProjectFn = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		if ctx != f.Ctx || id != f.Header.ProjectID || work == nil {
			t.Fatal("Step write changed Project scope or context")
		}
		if err := work(f.Scope); err != nil {
			failure := &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionNotCommitted}
			return store.Completion{Outcome: store.TransactionNotCommitted}, failure
		}
		return store.Completion{Outcome: outcome}, nil
	}
	f.Steps = taskservice.NewTaskSteps(f.Store, f.Capture)
	return f
}

func stepMutationHeader(version int64) model.TaskHeader {
	return model.TaskHeader{ProjectID: "22222222-2222-4222-8222-222222222222", ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: version}
}

func stepMutationRows() []model.TaskStep {
	return []model.TaskStep{
		{ID: "00000000", Position: 0, Title: "same", Description: "original body", Status: model.TaskStepTodo, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 3, 4, 5, 6, 654321000, time.UTC)},
		{ID: "abcdef01", Position: 1, Title: "same", Description: "other body", Status: model.TaskStepInProgress, CreatedAt: time.Date(2026, 1, 3, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 4, 4, 5, 6, 654321000, time.UTC)},
	}
}

func (f *stepWriteFixture) ExpectCapture(post model.TaskHeader, check func(protocol.Fact)) {
	f.T.Helper()
	headerCalls, captures := 0, 0
	f.Writer.TaskHeaderFn = func(ctx context.Context, id string) (model.TaskHeader, error) {
		if ctx != f.Ctx || id != f.Header.ID {
			f.T.Fatal("Step capture changed parent identity or context")
		}
		headerCalls++
		switch headerCalls {
		case 1:
			return f.Header, nil
		case 2:
			return post, nil
		default:
			f.T.Fatal("Step write unexpectedly reread its parent")
			panic("unexpected parent read")
		}
	}
	dao := &captureDAOMock{taskMockBase: f.Writer.taskMockBase.withLabel("captureDAO")}
	f.Scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return dao }
	f.Capture.CaptureBatchFn = func(ctx context.Context, actual store.WebhookCaptureDAO, facts []protocol.Fact) error {
		if ctx != f.Ctx || actual != dao || len(facts) != 1 {
			f.T.Fatal("Step write changed captured scope, context or fact count")
		}
		captures++
		check(facts[0])
		return nil
	}
	f.T.Cleanup(func() {
		if headerCalls != 2 || captures != 1 {
			f.T.Errorf("Step write capture calls: headers=%d captures=%d", headerCalls, captures)
		}
	})
}

func requireChangeCommitted(t *testing.T, result taskservice.StepsWriteResult, err error, changed bool) {
	t.Helper()
	if err != nil || result.Changed != changed || result.TransactionOutcome != store.TransactionCommitted || result.Phase != "commit" || result.CleanupFailed || len(result.JSON) == 0 {
		t.Fatalf("change receipt: %+v %v", result, err)
	}
}
