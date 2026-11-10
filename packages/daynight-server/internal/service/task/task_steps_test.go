package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/google/uuid"
)

func stepReadModels() (model.Project, model.Task, model.Principal) {
	observed := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	project := model.Project{ID: "33333333-3333-4333-8333-333333333333", Name: "Project", RepoURL: "https://github.com/example/repository", CreatedAt: observed, UpdatedAt: observed, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 120}, Ownership: model.ProjectOwnership{TeamID: "44444444-4444-4444-8444-444444444444", Version: 1, UpdatedAt: observed}}
	target := model.Task{ID: "55555555-5555-4555-8555-555555555555", ProjectID: project.ID, Title: "Task", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: observed, UpdatedAt: observed, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: &principal.UserID, Ready: true}
	return project, target, principal
}

func stepReadHeader(version int64) model.TaskHeader {
	project, target, _ := stepReadModels()
	return model.TaskHeader{ID: target.ID, ProjectID: project.ID, Version: version}
}

func stepReadValue(id string, position int64) model.TaskStep {
	observed := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.TaskStep{ID: id, Position: position, Title: "Step", Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed}
}

// The embedded interfaces deliberately have no implementation: any unconfigured
// capability fails immediately. The selected methods additionally verify order,
// arguments and lifetime for each invocation.
type stepReadFixture struct {
	t                                                         *testing.T
	ctx                                                       context.Context
	project                                                   model.Project
	principal                                                 model.Principal
	header                                                    model.TaskHeader
	projectID, taskID                                         string
	want                                                      []string
	active                                                    bool
	projectDAO                                                *stepReadProjectDAO
	taskDAO                                                   *stepReadTaskDAO
	snapshot                                                  *stepReadSnapshot
	svc                                                       *TaskSteps
	authErr, headerErr, rowsErr, itemErr, summaryErr, pageErr error
	startErr, completionErr, cleanupErr                       error
	rows                                                      []model.TaskStep
	item                                                      model.TaskStep
	summary                                                   store.TaskStepProjection
	page                                                      []store.TaskStepProjection
	stepID                                                    string
	after                                                     int64
	limit                                                     int
	summaryMode                                               bool
}

type stepReadStore struct {
	store.ProjectWriter
	f *stepReadFixture
}
type stepReadSnapshot struct {
	store.SnapshotScope
	f *stepReadFixture
}
type stepReadProjectDAO struct {
	store.ProjectReader
	f *stepReadFixture
}
type stepReadTaskDAO struct {
	store.TaskReader
	f *stepReadFixture
}

func (f *stepReadFixture) event(name string) {
	f.t.Helper()
	if len(f.want) == 0 || f.want[0] != name {
		f.t.Fatalf("unexpected call %s, remaining %v", name, f.want)
	}
	f.want = f.want[1:]
}
func (f *stepReadFixture) inScope(name string) {
	f.t.Helper()
	if !f.active {
		f.t.Fatalf("%s escaped snapshot scope", name)
	}
	f.event(name)
}
func (f *stepReadFixture) begin(events ...string) {
	f.t.Helper()
	if len(f.want) != 0 || f.active {
		f.t.Fatalf("previous call incomplete: %v", f.want)
	}
	f.want = slices.Clone(events)
}
func (f *stepReadFixture) end() {
	f.t.Helper()
	if len(f.want) != 0 || f.active {
		f.t.Fatalf("calls missing or scope still active: %v", f.want)
	}
}
func stepReadPath(operation string) []string {
	path := []string{"snapshot", "projectDAO", "authorize", "taskDAO", "header"}
	if operation != "" {
		path = append(path, "taskDAO", operation)
	}
	return append(path, "complete")
}
func (s *stepReadStore) ReadSnapshot(ctx context.Context, callback func(store.SnapshotScope) error) error {
	f := s.f
	f.event("snapshot")
	if ctx != f.ctx || callback == nil || f.active {
		f.t.Fatal("snapshot context, callback or lifetime changed")
	}
	if f.startErr != nil {
		f.event("complete")
		return f.startErr
	}
	f.active = true
	err := callback(f.snapshot)
	f.active = false
	f.event("complete")
	if f.cleanupErr != nil {
		return &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.Join(err, f.cleanupErr)}
	}
	if f.completionErr != nil {
		if err != nil {
			f.t.Fatalf("callback failed before snapshot completion: %v", err)
		}
		return f.completionErr
	}
	return err
}
func (s *stepReadSnapshot) ProjectDAO() store.ProjectReader {
	s.f.inScope("projectDAO")
	return s.f.projectDAO
}
func (s *stepReadSnapshot) TaskDAO() store.TaskReader { s.f.inScope("taskDAO"); return s.f.taskDAO }
func (d *stepReadProjectDAO) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	d.f.t.Fatal("authorization must not invoke ProjectAccess")
	return model.ProjectAccess{}, nil
}
func (d *stepReadTaskDAO) TaskHeader(ctx context.Context, project, task string) (model.TaskHeader, error) {
	f := d.f
	f.inScope("header")
	if ctx != f.ctx || project != f.projectID || task != f.taskID {
		f.t.Fatalf("header arguments: %q %q", project, task)
	}
	if f.headerErr != nil {
		return model.TaskHeader{}, f.headerErr
	}
	return f.header, nil
}
func (d *stepReadTaskDAO) TaskSteps(ctx context.Context, task string) ([]model.TaskStep, error) {
	f := d.f
	f.inScope("rows")
	if ctx != f.ctx || task != f.header.ID {
		f.t.Fatal("collection scope changed")
	}
	return slices.Clone(f.rows), f.rowsErr
}
func (d *stepReadTaskDAO) TaskStep(ctx context.Context, task, step string) (model.TaskStep, error) {
	f := d.f
	f.inScope("item")
	if ctx != f.ctx || task != f.header.ID || step != f.stepID {
		f.t.Fatalf("item scope changed: %q %q", task, step)
	}
	return f.item, f.itemErr
}
func (d *stepReadTaskDAO) TaskStepSummary(ctx context.Context, task, step string) (store.TaskStepProjection, error) {
	f := d.f
	f.inScope("summary")
	if ctx != f.ctx || task != f.header.ID || step != f.stepID {
		f.t.Fatalf("summary scope changed: %q %q", task, step)
	}
	return f.summary, f.summaryErr
}
func (d *stepReadTaskDAO) TaskStepPage(ctx context.Context, task string, after int64, limit int, summary bool) ([]store.TaskStepProjection, error) {
	f := d.f
	f.inScope("page")
	if ctx != f.ctx || task != f.header.ID || after != f.after || limit != f.limit || summary != f.summaryMode {
		f.t.Fatalf("page arguments: %q %d %d %v", task, after, limit, summary)
	}
	return slices.Clone(f.page), f.pageErr
}
func newStepReadFixture(t *testing.T, header model.TaskHeader) *stepReadFixture {
	t.Helper()
	project, _, principal := stepReadModels()
	f := &stepReadFixture{t: t, ctx: t.Context(), project: project, principal: principal, header: header, projectID: header.ProjectID, taskID: header.ID}
	f.projectDAO, f.taskDAO, f.snapshot = &stepReadProjectDAO{f: f}, &stepReadTaskDAO{f: f}, &stepReadSnapshot{f: f}
	f.svc = NewTaskSteps(&stepReadStore{f: f})
	if f.svc.readOperations.requireProjectRead == nil || reflect.ValueOf(f.svc.readOperations.requireProjectRead).Pointer() != reflect.ValueOf(projectcore.RequireProjectRead).Pointer() {
		t.Fatal("production constructor did not bind RequireProjectRead")
	}
	f.svc.readOperations.requireProjectRead = func(ctx context.Context, dao projectcore.ProjectAccessReader, principal model.Principal, projectID string) (model.ProjectAccess, error) {
		f.inScope("authorize")
		if ctx != f.ctx || dao != f.projectDAO || principal != f.principal || projectID != f.projectID {
			t.Fatalf("authorization identity changed: %+v %q", principal, projectID)
		}
		if f.authErr != nil {
			return model.ProjectAccess{}, f.authErr
		}
		return model.ProjectAccess{ProjectID: f.project.ID, UserID: f.principal.UserID, Role: model.ProjectAdmin, OwnerTeam: model.TeamRef{ID: f.project.Ownership.TeamID, Kind: "personal"}, Ownership: f.project.Ownership}, nil
	}
	return f
}
func stepReadFault(t *testing.T, err error, code string) {
	t.Helper()
	fault, ok := TaskStepsFault(err)
	if !ok || fault.Code != code {
		t.Fatalf("expected %s fault, got %v", code, err)
	}
}
func stepReadInternalError(t *testing.T, err, cause error) {
	t.Helper()
	if !errors.Is(err, cause) {
		t.Fatalf("error lost its cause: %v", err)
	}
	if _, ok := TaskStepsFault(err); ok {
		t.Fatalf("internal error classified as business refusal: %v", err)
	}
}
func stepReadJSON(t *testing.T, resource any, data []byte) {
	t.Helper()
	expected, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	expected = append(expected, '\n')
	if !bytes.Equal(data, expected) {
		t.Fatalf("encoded resource differs: %q", data)
	}
}

func TestTaskStepsReadWithoutHydratingTaskPolicyAndPreserveParent(t *testing.T) {
	f := newStepReadFixture(t, stepReadHeader(1))
	f.rows = []model.TaskStep{}
	f.begin(stepReadPath("rows")...)
	empty, err := f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
	f.end()
	if err != nil || empty.Resource.Steps == nil || len(empty.Resource.Steps) != 0 {
		t.Fatalf("empty: %+v %v", empty, err)
	}
	stepReadJSON(t, empty.Resource, empty.JSON)
	f.header.Version = 9007199254740993
	step := stepReadValue("00abcdef", 0)
	step.Title, step.Description, step.Status = "  \ufeff  ", "# Markdown", model.TaskStepSkipped
	step.CreatedAt, step.UpdatedAt = time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC), time.Date(2026, 11, 3, 10, 12, 13, 0, time.UTC)
	f.rows, f.item, f.stepID = []model.TaskStep{step}, step, step.ID
	before := f.header
	f.begin(stepReadPath("rows")...)
	result, err := f.svc.List(f.ctx, f.principal, strings.ToUpper(f.projectID), strings.ToUpper(f.taskID))
	f.end()
	expected := taskcodec.Step{ID: step.ID, Title: step.Title, Description: step.Description, Status: step.Status, CreatedAt: step.CreatedAt, UpdatedAt: step.UpdatedAt}
	if err != nil || result.Resource.ProjectID != f.projectID || result.Resource.TaskID != f.taskID || result.Resource.Version != f.header.Version || len(result.Resource.Steps) != 1 || result.Resource.Steps[0] != expected {
		t.Fatalf("list: %+v %v", result.Resource, err)
	}
	stepReadJSON(t, result.Resource, result.JSON)
	f.begin(stepReadPath("item")...)
	single, err := f.svc.Get(f.ctx, f.principal, f.projectID, f.taskID, "00ABCDEF")
	f.end()
	if err != nil || single.Resource.ProjectID != f.projectID || single.Resource.TaskID != f.taskID || single.Resource.Step != expected || single.Resource.Version != result.Resource.Version || f.header != before {
		t.Fatalf("single/header: %+v %v", single, err)
	}
	stepReadJSON(t, single.Resource, single.JSON)
}

func TestTaskStepsBatchPagesAndVersionFence(t *testing.T) {
	f := newStepReadFixture(t, stepReadHeader(1))
	first := store.TaskStepProjection{Step: stepReadValue("00000000", 0)}
	long := store.TaskStepProjection{Step: stepReadValue("00000001", 1), TitleTruncated: true}
	long.Step.Title = strings.Repeat("界", 512)
	last := store.TaskStepProjection{Step: stepReadValue("00000002", 2)}
	last.Step.Description = strings.Repeat("x", 10000)
	lastSummary := last
	lastSummary.Step.Description = ""
	f.after, f.limit, f.summaryMode, f.page = -1, 3, true, []store.TaskStepProjection{first, long, lastSummary}
	f.begin(stepReadPath("page")...)
	page, err := f.svc.ListPage(f.ctx, f.principal, f.projectID, f.taskID, -1, 2, nil, true)
	f.end()
	if err != nil || page.Header != f.header || !page.HasMore || !reflect.DeepEqual(page.Items, []store.TaskStepProjection{first, long}) || utf8.RuneCountInString(page.Items[1].Step.Title) != 512 {
		t.Fatalf("first page: %+v %v", page, err)
	}
	version := page.Header.Version
	f.after, f.summaryMode, f.page = 1, false, []store.TaskStepProjection{last}
	f.begin(stepReadPath("page")...)
	next, err := f.svc.ListPage(f.ctx, f.principal, f.projectID, f.taskID, 1, 2, &version, false)
	f.end()
	if err != nil || next.Header != f.header || next.HasMore || !reflect.DeepEqual(next.Items, []store.TaskStepProjection{last}) || len(next.Items[0].Step.Description) != 10000 {
		t.Fatalf("next: %+v %v", next, err)
	}
	f.stepID, f.summary = "00000001", long
	f.begin(stepReadPath("summary")...)
	single, err := f.svc.GetSummary(f.ctx, f.principal, f.projectID, f.taskID, f.stepID)
	f.end()
	if err != nil || single.Header != f.header || single.Item != long || !single.Item.TitleTruncated || single.Item.Step.Position != 1 || single.Item.Step.Description != "" {
		t.Fatalf("summary: %+v %v", single, err)
	}
	f.stepID, f.summaryErr = "ffffffff", model.ErrNotFound
	f.begin(stepReadPath("summary")...)
	_, err = f.svc.GetSummary(f.ctx, f.principal, f.projectID, f.taskID, f.stepID)
	f.end()
	var absence *tasksteps.StepAbsence
	if !errors.As(err, &absence) || absence.Version != version {
		t.Fatalf("missing Step version: %v", err)
	}
	f.header.Version++
	f.begin("snapshot", "projectDAO", "authorize", "taskDAO", "header", "taskDAO", "complete")
	_, err = f.svc.ListPage(f.ctx, f.principal, f.projectID, f.taskID, 1, 2, &version, true)
	f.end()
	stepReadFault(t, err, "version_conflict")
	for _, bounds := range [][2]int64{{-2, 1}, {-1, 0}, {-1, 101}} {
		f.begin()
		_, err := f.svc.ListPage(f.ctx, f.principal, f.projectID, f.taskID, bounds[0], int(bounds[1]), nil, true)
		f.end()
		stepReadFault(t, err, "invalid_input")
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
			f := newStepReadFixture(t, stepReadHeader(1))
			principal := model.Principal{}
			if tc.principal {
				principal = f.principal
			}
			project, task := f.projectID, f.taskID
			if tc.projectID != "" {
				project = tc.projectID
			}
			if tc.taskID != "" {
				task = tc.taskID
			}
			switch tc.name {
			case "missing project", "access denied":
				f.projectID = project
				f.authErr = &model.Fault{Code: "not_found", Message: "Project not found.", Cause: model.ErrNotFound}
				f.begin("snapshot", "projectDAO", "authorize", "complete")
			case "missing task":
				f.taskID = task
				f.headerErr = model.ErrNotFound
				f.begin(stepReadPath("")...)
			default:
				f.begin()
			}
			result, err := f.svc.List(f.ctx, principal, project, task)
			f.end()
			stepReadFault(t, err, tc.code)
			if !reflect.DeepEqual(result, StepsDocument{}) {
				t.Fatalf("failure leaked result: %+v", result)
			}
		})
	}
	f := newStepReadFixture(t, stepReadHeader(1))
	for _, read := range []func() error{func() error {
		_, err := f.svc.Get(f.ctx, model.Principal{}, f.projectID, f.taskID, "00000000")
		return err
	}, func() error {
		_, err := f.svc.GetSummary(f.ctx, model.Principal{}, f.projectID, f.taskID, "00000000")
		return err
	}} {
		f.begin()
		err := read()
		f.end()
		stepReadFault(t, err, "unauthenticated")
	}
	for _, id := range []string{"bad", "00000000-0000-4000-8000-000000000001"} {
		f.begin()
		_, err := f.svc.Get(f.ctx, f.principal, f.projectID, f.taskID, id)
		f.end()
		stepReadFault(t, err, "invalid_input")
		f.begin()
		_, err = f.svc.GetSummary(f.ctx, f.principal, f.projectID, f.taskID, id)
		f.end()
		stepReadFault(t, err, "invalid_input")
	}
	f.stepID, f.itemErr = "00000000", model.ErrNotFound
	f.begin(stepReadPath("item")...)
	missing, err := f.svc.Get(f.ctx, f.principal, f.projectID, f.taskID, f.stepID)
	f.end()
	stepReadFault(t, err, "not_found")
	if !reflect.DeepEqual(missing, StepDocument{}) {
		t.Fatalf("missing item leaked: %+v", missing)
	}
	deleted := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	f.header.DeletedAt = &deleted
	f.begin(stepReadPath("")...)
	_, err = f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
	f.end()
	stepReadFault(t, err, "task_deleted")
	f.begin(stepReadPath("")...)
	_, err = f.svc.GetSummary(f.ctx, f.principal, f.projectID, f.taskID, f.stepID)
	f.end()
	stepReadFault(t, err, "task_deleted")
	f.header.DeletedAt = nil
	failure := errors.New("Step query failed")
	f.itemErr, f.summaryErr, f.rowsErr = failure, failure, failure
	f.begin(stepReadPath("item")...)
	failedItem, err := f.svc.Get(f.ctx, f.principal, f.projectID, f.taskID, f.stepID)
	f.end()
	stepReadInternalError(t, err, failure)
	if !reflect.DeepEqual(failedItem, StepDocument{}) {
		t.Fatalf("item query failure concealed: %+v %v", failedItem, err)
	}
	f.begin(stepReadPath("summary")...)
	failedSummary, err := f.svc.GetSummary(f.ctx, f.principal, f.projectID, f.taskID, f.stepID)
	f.end()
	stepReadInternalError(t, err, failure)
	if failedSummary != (StepSummary{}) {
		t.Fatalf("summary query failure concealed: %+v %v", failedSummary, err)
	}
	f.begin(stepReadPath("rows")...)
	failedRows, err := f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
	f.end()
	stepReadInternalError(t, err, failure)
	if !reflect.DeepEqual(failedRows, StepsDocument{}) {
		t.Fatalf("collection query failure concealed: %+v %v", failedRows, err)
	}
	snapshotFailure := errors.New("snapshot failed")
	f.startErr = snapshotFailure
	f.begin("snapshot", "complete")
	failedRows, err = f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
	f.end()
	stepReadInternalError(t, err, snapshotFailure)
	if !reflect.DeepEqual(failedRows, StepsDocument{}) {
		t.Fatalf("snapshot failure concealed: %+v %v", failedRows, err)
	}
	if !reflect.DeepEqual(f.header, stepReadHeader(1)) {
		t.Fatal("read changed synthetic parent")
	}

	for _, kind := range []string{"list", "get", "page", "summary"} {
		t.Run("completion "+kind, func(t *testing.T) {
			f := newStepReadFixture(t, stepReadHeader(1))
			step := stepReadValue("00000000", 0)
			f.stepID, f.item, f.rows, f.summary = step.ID, step, []model.TaskStep{step}, store.TaskStepProjection{Step: step}
			f.after, f.limit, f.page = -1, 2, []store.TaskStepProjection{{Step: step}}
			completion := errors.New("snapshot completion failed")
			f.completionErr = completion
			switch kind {
			case "list":
				f.begin(stepReadPath("rows")...)
				result, err := f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
				f.end()
				if !errors.Is(err, completion) || !reflect.DeepEqual(result, StepsDocument{}) {
					t.Fatalf("completion leaked list: %+v %v", result, err)
				}
			case "get":
				f.begin(stepReadPath("item")...)
				result, err := f.svc.Get(f.ctx, f.principal, f.projectID, f.taskID, step.ID)
				f.end()
				if !errors.Is(err, completion) || !reflect.DeepEqual(result, StepDocument{}) {
					t.Fatalf("completion leaked item: %+v %v", result, err)
				}
			case "page":
				f.begin(stepReadPath("page")...)
				result, err := f.svc.ListPage(f.ctx, f.principal, f.projectID, f.taskID, -1, 1, nil, false)
				f.end()
				if !errors.Is(err, completion) || !reflect.DeepEqual(result, StepsPage{}) {
					t.Fatalf("completion leaked page: %+v %v", result, err)
				}
			case "summary":
				f.begin(stepReadPath("summary")...)
				result, err := f.svc.GetSummary(f.ctx, f.principal, f.projectID, f.taskID, step.ID)
				f.end()
				if !errors.Is(err, completion) || result != (StepSummary{}) {
					t.Fatalf("completion leaked summary: %+v %v", result, err)
				}
			}
		})
	}
	t.Run("refusal and cleanup failure", func(t *testing.T) {
		f := newStepReadFixture(t, stepReadHeader(1))
		refusal := &model.Fault{Code: "not_found", Message: "Project not found.", Cause: model.ErrNotFound}
		cleanup := errors.New("cleanup failed")
		f.authErr, f.cleanupErr = refusal, cleanup
		f.begin("snapshot", "projectDAO", "authorize", "complete")
		result, err := f.svc.List(f.ctx, f.principal, f.projectID, f.taskID)
		f.end()
		var transaction *store.TransactionError
		if !reflect.DeepEqual(result, StepsDocument{}) || !errors.As(err, &transaction) || transaction.Phase != "cleanup" || transaction.Outcome != store.TransactionUnknown || !transaction.CleanupFailed || !errors.Is(err, refusal) || !errors.Is(err, cleanup) || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("cleanup failure lost: %+v %v", result, err)
		}
		if _, ok := TaskStepsFault(err); ok {
			t.Fatal("cleanup failure classified as pure refusal")
		}
	})
}

func TestTaskStepsFaultDoesNotHideCleanupFailure(t *testing.T) {
	refusal := &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: model.ErrNotFound}
	wrapped := fmt.Errorf("read: %w", &store.Error{Phase: "snapshot", Cause: refusal})
	if actual, ok := TaskStepsFault(wrapped); !ok || actual != refusal {
		t.Fatal("pure refusal lost")
	}
	if actual, ok := TaskStepsFault(fmt.Errorf("snapshot: %w", errors.Join(model.ErrNotFound, wrapped))); !ok || actual != refusal {
		t.Fatal("store marker hid pure refusal")
	}
	cleanup := errors.New("cleanup failed")
	for _, err := range []error{nil, cleanup, model.ErrNotFound, fmt.Errorf("read: %w", errors.Join(refusal, cleanup))} {
		if _, ok := TaskStepsFault(err); ok {
			t.Fatal("cleanup error downgraded")
		}
	}
	joined := errors.Join(refusal, cleanup)
	if !errors.Is(joined, cleanup) || !errors.Is(joined, model.ErrNotFound) {
		t.Fatal("error chain changed")
	}
}
