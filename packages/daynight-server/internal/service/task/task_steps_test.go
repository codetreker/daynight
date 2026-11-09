package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func stepMockHeader(version int64) model.TaskHeader {
	project, target, _ := taskMockModels()
	return model.TaskHeader{ID: target.ID, ProjectID: project.ID, Version: version}
}

type stepsReadFixture struct {
	T             *testing.T
	Ctx           context.Context
	Header        model.TaskHeader
	Project       model.Project
	Principal     model.Principal
	Reader        *taskReaderMock
	ProjectReader *projectReaderMock
	Snapshot      *taskSnapshotScopeMock
	Store         *taskStoreMock
	Steps         *taskservice.TaskSteps
}

func newStepsReadFixture(t *testing.T, header model.TaskHeader) *stepsReadFixture {
	t.Helper()
	project, _, principal := taskMockModels()
	project.ID = header.ProjectID
	base := newTaskMockBase(t, "steps")
	f := &stepsReadFixture{T: t, Ctx: t.Context(), Header: header, Project: project, Principal: principal}
	f.Reader = &taskReaderMock{taskMockBase: base.withLabel("steps.reader")}
	f.ProjectReader = &projectReaderMock{taskMockBase: base.withLabel("steps.project")}
	f.ProjectReader.ProjectAccessFn = func(ctx context.Context, actual model.Principal, projectID string) (model.ProjectAccess, error) {
		if ctx != f.Ctx || actual != f.Principal || projectID != f.Header.ProjectID {
			t.Fatal("Step read changed the access context, principal or Project identity")
		}
		return taskMockAccess(f.Project, f.Principal), nil
	}
	f.Reader.TaskHeaderFn = func(ctx context.Context, projectID, taskID string) (model.TaskHeader, error) {
		if ctx != f.Ctx || projectID != f.Header.ProjectID || taskID != f.Header.ID {
			t.Fatal("Step read changed the header context or scoped Task identity")
		}
		return f.Header, nil
	}
	f.Snapshot = &taskSnapshotScopeMock{taskMockBase: base.withLabel("steps.snapshot"), ProjectDAOFn: func() store.ProjectReader { return f.ProjectReader }, TaskDAOFn: func() store.TaskReader { return f.Reader }}
	f.Store = &taskStoreMock{taskMockBase: base.withLabel("steps.store"), ReadSnapshotFn: func(ctx context.Context, read func(store.SnapshotScope) error) error {
		if ctx != f.Ctx || read == nil {
			t.Fatal("Step read changed the snapshot context or callback")
		}
		return read(f.Snapshot)
	}}
	f.Steps = taskservice.NewTaskSteps(f.Store)
	return f
}

func (f *stepsReadFixture) expectRows(rows []model.TaskStep) {
	f.T.Helper()
	f.Reader.TaskStepsFn = func(ctx context.Context, taskID string) ([]model.TaskStep, error) {
		if ctx != f.Ctx || taskID != f.Header.ID {
			f.T.Fatal("Step collection changed context or Task identity")
		}
		return slices.Clone(rows), nil
	}
}

func stepProjection(id string, position int64, description string) store.TaskStepProjection {
	step := taskMockStep(id, position)
	step.Description = description
	return store.TaskStepProjection{Step: step}
}

func TestTaskStepsReadWithoutHydratingTaskPolicyAndPreserveParent(t *testing.T) {
	f := newStepsReadFixture(t, stepMockHeader(1))
	f.expectRows([]model.TaskStep{})
	empty, err := f.Steps.List(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID)
	if err != nil || empty.Resource.Steps == nil || len(empty.Resource.Steps) != 0 {
		t.Fatalf("empty: %+v %v", empty, err)
	}
	f.Header.Version = 9007199254740993
	step := taskMockStep("00abcdef", 0)
	step.Title, step.Description, step.Status = "  \ufeff  ", "# Markdown", model.TaskStepSkipped
	step.CreatedAt, step.UpdatedAt = time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC), time.Date(2026, 11, 3, 10, 12, 13, 0, time.UTC)
	f.expectRows([]model.TaskStep{step})
	f.Reader.TaskStepFn = func(ctx context.Context, taskID, id string) (model.TaskStep, error) {
		if ctx != f.Ctx || taskID != f.Header.ID || id != "00abcdef" {
			t.Fatal("Step identity was not canonicalized")
		}
		return step, nil
	}
	f.Reader.TaskStepSummaryFn = func(ctx context.Context, taskID, id string) (store.TaskStepProjection, error) {
		if ctx != f.Ctx || taskID != f.Header.ID || id != "00abcdef" {
			t.Fatal("Step summary identity changed")
		}
		return store.TaskStepProjection{Step: step}, nil
	}
	before := f.Header
	result, err := f.Steps.List(f.Ctx, f.Principal, strings.ToUpper(f.Header.ProjectID), strings.ToUpper(f.Header.ID))
	if err != nil || result.Resource.Version != 9007199254740993 || len(result.Resource.Steps) != 1 || result.Resource.Steps[0].ID != "00abcdef" {
		t.Fatalf("independent read: %+v %v", result.Resource, err)
	}
	single, err := f.Steps.Get(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00ABCDEF")
	if err != nil || single.Resource.Step != result.Resource.Steps[0] || single.Resource.Version != result.Resource.Version || f.Header != before {
		t.Fatalf("single/header: %+v %v", single, err)
	}

}

func TestTaskStepsBatchPagesAndVersionFence(t *testing.T) {
	f := newStepsReadFixture(t, stepMockHeader(1))
	first := stepProjection("00000000", 0, "")
	long := stepProjection("00000001", 1, "")
	long.Step.Title = strings.Repeat("界", 512)
	long.TitleTruncated = true
	last := stepProjection("00000002", 2, strings.Repeat("x", 10000))
	lastSummary := last
	lastSummary.Step.Description = ""
	f.Reader.TaskStepPageFn = func(ctx context.Context, id string, after int64, limit int, summary bool) ([]store.TaskStepProjection, error) {
		if ctx != f.Ctx || id != f.Header.ID || limit != 3 {
			t.Fatal("page query changed bounds or scope")
		}
		switch after {
		case -1:
			if !summary {
				t.Fatal("summary projection was not requested")
			}
			return []store.TaskStepProjection{first, long, lastSummary}, nil
		case 1:
			if summary {
				t.Fatal("full projection was not requested")
			}
			return []store.TaskStepProjection{last}, nil
		}
		t.Fatal("unexpected page position")
		return nil, nil
	}
	page, err := f.Steps.ListPage(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, -1, 2, nil, true)
	if err != nil || len(page.Items) != 2 || !page.HasMore || page.Header.Version != 1 {
		t.Fatalf("first page: %+v %v", page, err)
	}
	if page.Items[0].Step.Description != "" || page.Items[0].TitleTruncated || !page.Items[1].TitleTruncated || utf8.RuneCountInString(page.Items[1].Step.Title) != 512 || page.Items[1].Step.Description != "" {
		t.Fatalf("summary forwarding: %+v", page.Items)
	}
	version := page.Header.Version
	next, err := f.Steps.ListPage(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, 1, 2, &version, false)
	if err != nil || len(next.Items) != 1 || next.HasMore || next.Items[0].Step.ID != "00000002" || len(next.Items[0].Step.Description) != 10000 {
		t.Fatalf("next: %+v %v", next, err)
	}
	f.Reader.TaskStepSummaryFn = func(ctx context.Context, id, stepID string) (store.TaskStepProjection, error) {
		if ctx != f.Ctx || id != f.Header.ID {
			t.Fatal("summary scope changed")
		}
		if stepID == "ffffffff" {
			return store.TaskStepProjection{}, model.ErrNotFound
		}
		if stepID != "00000001" {
			t.Fatal("summary Step changed")
		}
		return long, nil
	}
	single, err := f.Steps.GetSummary(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000001")
	if err != nil || single.Header.Version != version || !single.Item.TitleTruncated || single.Item.Step.Position != 1 || single.Item.Step.Description != "" {
		t.Fatalf("summary: %+v %v", single, err)
	}
	_, err = f.Steps.GetSummary(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "ffffffff")
	var absence *tasksteps.StepAbsence
	if !errors.As(err, &absence) || absence.Version != version {
		t.Fatalf("missing Step version: %v", err)
	}
	f.Header.Version++
	f.Reader.TaskStepPageFn = nil
	_, err = f.Steps.ListPage(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, 1, 2, &version, true)
	requireThreadFault(t, err, "version_conflict")
	for _, bounds := range [][2]int64{{-2, 1}, {-1, 0}, {-1, 101}} {
		_, err := f.Steps.ListPage(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, bounds[0], int(bounds[1]), nil, true)
		requireThreadFault(t, err, "invalid_input")
	}
}

func TestTaskStepsReadScopeAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		principal               bool
		projectID, taskID, code string
	}{
		{name: "unauthenticated", code: "unauthenticated"}, {name: "project syntax", principal: true, projectID: "bad", code: "invalid_input"}, {name: "task syntax", principal: true, taskID: "bad", code: "invalid_input"},
		{name: "missing project", principal: true, projectID: uuid.NewString(), code: "not_found"}, {name: "missing task", principal: true, taskID: uuid.NewString(), code: "not_found"}, {name: "access denied", principal: true, code: "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newStepsReadFixture(t, stepMockHeader(1))
			principal := model.Principal{}
			if tc.principal {
				principal = f.Principal
			}
			projectID, taskID := f.Header.ProjectID, f.Header.ID
			if tc.projectID != "" {
				projectID = tc.projectID
			}
			if tc.taskID != "" {
				taskID = tc.taskID
			}
			switch tc.name {
			case "missing project", "access denied":
				f.ProjectReader.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, model.ErrNotFound
				}
			case "missing task":
				f.Reader.TaskHeaderFn = func(context.Context, string, string) (model.TaskHeader, error) {
					return model.TaskHeader{}, model.ErrNotFound
				}
			default:
				f.Store.ReadSnapshotFn = nil
			}
			_, err := f.Steps.List(f.Ctx, principal, projectID, taskID)
			requireThreadFault(t, err, tc.code)
		})
	}
	f := newStepsReadFixture(t, stepMockHeader(1))
	for _, read := range []func() error{func() error {
		_, err := f.Steps.Get(f.Ctx, model.Principal{}, f.Header.ProjectID, f.Header.ID, "00000000")
		return err
	}, func() error {
		_, err := f.Steps.GetSummary(f.Ctx, model.Principal{}, f.Header.ProjectID, f.Header.ID, "00000000")
		return err
	}} {
		requireThreadFault(t, read(), "unauthenticated")
	}
	for _, id := range []string{"bad", "00000000-0000-4000-8000-000000000001"} {
		_, err := f.Steps.Get(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, id)
		requireThreadFault(t, err, "invalid_input")
		_, err = f.Steps.GetSummary(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, id)
		requireThreadFault(t, err, "invalid_input")
	}
	f.Reader.TaskStepFn = func(context.Context, string, string) (model.TaskStep, error) {
		return model.TaskStep{}, model.ErrNotFound
	}
	_, err := f.Steps.Get(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000")
	requireThreadFault(t, err, "not_found")
	deleted := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	f.Header.DeletedAt = &deleted
	_, err = f.Steps.List(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID)
	requireThreadFault(t, err, "task_deleted")
	_, err = f.Steps.GetSummary(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000")
	requireThreadFault(t, err, "task_deleted")
	f.Header.DeletedAt = nil
	failure := errors.New("Step query failed")
	f.Reader.TaskStepFn = func(context.Context, string, string) (model.TaskStep, error) { return model.TaskStep{}, failure }
	f.Reader.TaskStepSummaryFn = func(context.Context, string, string) (store.TaskStepProjection, error) {
		return store.TaskStepProjection{}, failure
	}
	f.Reader.TaskStepsFn = func(context.Context, string) ([]model.TaskStep, error) { return nil, failure }
	for _, read := range []func() error{func() error {
		_, err := f.Steps.Get(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000")
		return err
	}, func() error {
		_, err := f.Steps.GetSummary(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, "00000000")
		return err
	}, func() error { _, err := f.Steps.List(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID); return err }} {
		if err := read(); !errors.Is(err, failure) {
			t.Fatalf("query failure concealed: %v", err)
		}
	}
	snapshotFailure := errors.New("snapshot failed")
	f.Store.ReadSnapshotFn = func(context.Context, func(store.SnapshotScope) error) error { return snapshotFailure }
	_, err = f.Steps.List(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID)
	if !errors.Is(err, snapshotFailure) {
		t.Fatalf("snapshot failure concealed: %v", err)
	}
	if !reflect.DeepEqual(f.Header, stepMockHeader(1)) {
		t.Fatal("read changed synthetic parent")
	}
}

func TestTaskStepsFaultDoesNotHideCleanupFailure(t *testing.T) {
	refusal := &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: model.ErrNotFound}
	wrapped := fmt.Errorf("read: %w", &store.Error{Phase: "snapshot", Cause: refusal})
	if actual, ok := taskservice.TaskStepsFault(wrapped); !ok || actual != refusal {
		t.Fatal("pure refusal lost")
	}
	if actual, ok := taskservice.TaskStepsFault(fmt.Errorf("snapshot: %w", errors.Join(model.ErrNotFound, wrapped))); !ok || actual != refusal {
		t.Fatal("store marker hid pure refusal")
	}
	cleanup := errors.New("cleanup failed")
	for _, err := range []error{nil, cleanup, model.ErrNotFound, fmt.Errorf("read: %w", errors.Join(refusal, cleanup))} {
		if _, ok := taskservice.TaskStepsFault(err); ok {
			t.Fatal("cleanup error downgraded")
		}
	}
	joined := errors.Join(refusal, cleanup)
	if !errors.Is(joined, cleanup) || !errors.Is(joined, model.ErrNotFound) {
		t.Fatal("error chain changed")
	}
}
