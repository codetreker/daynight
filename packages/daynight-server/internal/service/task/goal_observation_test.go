package task

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type goalObservationReader struct{ *workServiceReader }

func (r goalObservationReader) GoalProgresses(_ context.Context, _ string, ids []string) (map[string]model.GoalProgress, error) {
	out := make(map[string]model.GoalProgress, len(ids))
	for _, id := range ids {
		out[id] = model.GoalProgress{}
	}
	return out, nil
}

type goalObservationSources struct {
	store.SessionReader
	t        *testing.T
	expected string
	fail     error
	calls    int
}

func (r *goalObservationSources) TaskSessionSources(_ context.Context, project string, ids []string) ([]store.TaskSessionSource, error) {
	r.calls++
	if project != workProject || !reflect.DeepEqual(ids, []string{r.expected}) {
		r.t.Fatalf("unexpected source selection %s %v", project, ids)
	}
	if r.fail != nil {
		return nil, r.fail
	}
	return []store.TaskSessionSource{{ProjectID: project, TaskID: r.expected, TaskVersion: 1, TaskStatus: model.TaskInProgress}}, nil
}

type goalObservationEngine struct {
	t        *testing.T
	expected string
	fail     error
	calls    int
}

func (e *goalObservationEngine) ObserveTaskSessions(_ context.Context, _ model.Principal, sources []store.TaskSessionSource) (map[string]sp.TaskSessionObservation, error) {
	e.calls++
	if len(sources) != 1 || sources[0].TaskID != e.expected {
		e.t.Fatalf("unexpected samples %+v", sources)
	}
	if e.fail != nil {
		return nil, e.fail
	}
	return map[string]sp.TaskSessionObservation{e.expected: {SchemaVersion: 1, Observation: "observed", Registration: "not_registered", Reason: "not_registered"}}, nil
}
func assertGoalObservation(t *testing.T, value sp.TaskSessionObservation) {
	t.Helper()
	if value.SchemaVersion != 1 || value.Observation != "observed" || value.Registration != "not_applicable" || value.Reason != "no_execution" || value.Send.Allowed == nil || *value.Send.Allowed || value.Send.Reason != "no_execution" || value.ObservedAt == nil || value.FreshUntil == nil || value.Error != nil {
		t.Fatalf("Goal observation %+v", value)
	}
}
func TestGoalObservationNeverLoadsExecutionSources(t *testing.T) {
	service, reader, _, database := workServiceFixture(t)
	goal := observationTask()
	goal.Type = model.TaskTypeGoal
	goal.Status = model.TaskTodo
	source := &goalObservationSources{t: t, expected: "ordinary", fail: errors.New("must not query")}
	engine := &goalObservationEngine{t: t, expected: "ordinary", fail: errors.New("must not sample")}
	snapshot := database.snapshot.(workServiceSnapshot)
	snapshot.tasks = goalObservationReader{reader}
	snapshot.sessions = source
	database.snapshot = snapshot
	service.observer = engine
	service.operations.task = func(context.Context, taskcore.ReadDAO, string, string) (model.Task, *model.Fault, error) {
		return goal, nil, nil
	}
	got, err := service.ObserveGet(t.Context(), observationActor(), workProject, goal.ID)
	if err != nil || got.Task.Progress == nil || source.calls != 0 || engine.calls != 0 {
		t.Fatalf("Goal get %+v %v sources=%d samples=%d", got, err, source.calls, engine.calls)
	}
	assertGoalObservation(t, got.Session)
	service.operations.list = func(context.Context, taskcore.ReadDAO, string, taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
		return store.TaskPage{Items: []model.Task{goal}}, nil, nil
	}
	page, err := service.ObserveList(t.Context(), observationActor(), workProject, TaskListRequest{Type: model.TaskTypeGoal, PageRequest: model.PageRequest{Limit: 2}})
	if err != nil || page.Partial || len(page.Items) != 1 || source.calls != 0 || engine.calls != 0 {
		t.Fatalf("Goal list %+v %v", page, err)
	}
	assertGoalObservation(t, page.Items[0].Session)
	service.operations.mcpList = func(context.Context, taskcore.MCPListReader, string, taskcore.MCPListSelection) (taskcore.MCPListPage, error) {
		return taskcore.MCPListPage{Items: []store.TaskPriorityItem{{Task: goal}}}, nil
	}
	reader.bodies = func(context.Context, string, []string) ([]model.Task, error) { return []model.Task{goal}, nil }
	for _, view := range []string{"summary", "full"} {
		result, err := service.ObservedMCPList(t.Context(), observationActor(), workProject, taskcore.MCPListRequest{Limit: 2, View: view})
		if err != nil || result.Partial || len(result.Items) != 1 || source.calls != 0 || engine.calls != 0 {
			t.Fatalf("Goal MCP %s: %+v %v", view, result, err)
		}
		assertGoalObservation(t, result.Items[0].Session)
		if view == "full" && result.Items[0].Item.Task.Progress == nil {
			t.Fatal("full Goal omitted progress")
		}
	}
}
func TestMixedGoalObservationIsIndependentOfSessionFailures(t *testing.T) {
	for _, stage := range []string{"success", "source", "sample", "recheck authorization"} {
		t.Run(stage, func(t *testing.T) {
			service, reader, _, database := workServiceFixture(t)
			ordinary := observationTask()
			ordinary.Type = model.TaskTypeTask
			goal := ordinary
			goal.Type = model.TaskTypeGoal
			goal.ID = "10000000-0000-4000-8000-000000000004"
			goal.Status = model.TaskTodo
			source := &goalObservationSources{t: t, expected: ordinary.ID}
			engine := &goalObservationEngine{t: t, expected: ordinary.ID}
			failure := errors.New("Session unavailable")
			if stage == "source" {
				source.fail = failure
			}
			if stage == "sample" {
				engine.fail = failure
			}
			snapshot := database.snapshot.(workServiceSnapshot)
			snapshot.tasks = goalObservationReader{reader}
			snapshot.sessions = source
			database.snapshot = snapshot
			service.observer = engine
			authCalls := 0
			service.operations.access = func(_ context.Context, _ projectcore.ProjectAccessReader, _ model.Principal, _ string) (model.ProjectAccess, error) {
				authCalls++
				if stage == "recheck authorization" && authCalls == 2 {
					return model.ProjectAccess{}, &model.Fault{Code: "forbidden", Message: "revoked"}
				}
				return model.ProjectAccess{}, nil
			}
			service.operations.list = func(context.Context, taskcore.ReadDAO, string, taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
				return store.TaskPage{Items: []model.Task{goal, ordinary}}, nil, nil
			}
			result, err := service.ObserveList(t.Context(), observationActor(), workProject, TaskListRequest{PageRequest: model.PageRequest{Limit: 2}})
			if stage == "recheck authorization" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "forbidden" || result.Items != nil {
					t.Fatalf("authorization lost %+v %v", result, err)
				}
				return
			}
			if err != nil || len(result.Items) != 2 || result.Partial != (stage != "success") {
				t.Fatalf("mixed result %+v %v", result, err)
			}
			assertGoalObservation(t, result.Items[0].Session)
			if stage == "success" && result.Items[1].Session.Observation != "observed" || stage != "success" && result.Items[1].Session.Observation != "unavailable" {
				t.Fatalf("ordinary observation %+v", result.Items[1].Session)
			}
			expectedSources, expectedSamples := 2, 1
			if stage == "source" {
				expectedSources, expectedSamples = 1, 0
			}
			if source.calls != expectedSources || engine.calls != expectedSamples {
				t.Fatalf("source/samples %d/%d", source.calls, engine.calls)
			}
		})
	}
}
