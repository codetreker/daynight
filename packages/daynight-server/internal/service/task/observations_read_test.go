package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type observationProjectReader struct{ store.ProjectReader }

func (observationProjectReader) Project(context.Context, string) (model.Project, error) {
	return model.Project{ID: workProject}, nil
}
func observationTask() model.Task {
	return model.Task{ID: workGroup, ProjectID: workProject, Version: 1, Status: model.TaskInProgress, CreatedAt: workTime, Properties: model.TaskProperties{}}
}
func observationActor() model.Principal {
	return model.Principal{UserID: workActor, CredentialID: workProject, Kind: model.PATCredential}
}
func TestObservedReadsPreserveSelectedTaskAndCoreOperationBoundaries(t *testing.T) {
	service, reader, _, database := workServiceFixture(t)
	task := observationTask()
	actor := observationActor()
	calls := 0
	service.operations.task = func(ctx context.Context, _ taskcore.ReadDAO, pid, id string) (model.Task, *model.Fault, error) {
		calls++
		if pid != workProject || id != workGroup || ctx != t.Context() {
			t.Fatal("wrong task read arguments")
		}
		return task, nil, nil
	}
	got, err := service.ObserveGet(t.Context(), actor, workProject, workGroup)
	if err != nil || calls != 1 || got.Task.ID != task.ID || got.Epoch != workProject || got.Session.Observation != "observed" {
		t.Fatalf("get %#v %v calls=%d", got, err, calls)
	}
	service.operations.list = func(_ context.Context, _ taskcore.ReadDAO, pid string, selection taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
		if pid != workProject || selection.Query.Page.Limit != 1 {
			t.Fatal("wrong list selection")
		}
		return store.TaskPage{Items: []model.Task{task}, HasMore: true}, nil, nil
	}
	list, err := service.ObserveList(t.Context(), actor, workProject, TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
	if err != nil || len(list.Items) != 1 || list.Items[0].Task.ID != task.ID || list.NextCursor == nil || list.Partial {
		t.Fatalf("list %#v %v", list, err)
	}
	service.operations.mcpList = func(_ context.Context, _ taskcore.MCPListReader, pid string, _ taskcore.MCPListSelection) (taskcore.MCPListPage, error) {
		if pid != workProject {
			t.Fatal("wrong MCP project")
		}
		return taskcore.MCPListPage{Items: []store.TaskPriorityItem{{Task: task, TitleTruncated: true, BlockedByCount: 4}}}, nil
	}
	reader.bodies = func(ctx context.Context, project string, ids []string) ([]model.Task, error) {
		if ctx != t.Context() || project != workProject || len(ids) != 1 || ids[0] != task.ID {
			t.Fatal("wrong batched body request")
		}
		return []model.Task{task}, nil
	}
	mcp, err := service.ObservedMCPList(t.Context(), actor, workProject, taskcore.MCPListRequest{Limit: 1, View: "full"})
	if err != nil || len(mcp.Items) != 1 || mcp.Items[0].Item.BlockedByCount != 4 || !mcp.Items[0].Item.TitleTruncated || calls != 1 {
		t.Fatalf("MCP %#v %v calls=%d", mcp, err, calls)
	}
	database.completion = errors.New("completion")
	if result, err := service.ObserveGet(t.Context(), actor, workProject, workGroup); !errors.Is(err, database.completion) || result.Task.ID != "" {
		t.Fatalf("failed completion exposed result %#v %v", result, err)
	}
}
func TestObservedGraphSeparatesExternalContributors(t *testing.T) {
	service, _, _, database := workServiceFixture(t)
	snapshot := database.snapshot.(workServiceSnapshot)
	snapshot.project = observationProjectReader{}
	database.snapshot = snapshot
	const child = "20000000-0000-4000-8000-000000000001"
	const external = "20000000-0000-4000-8000-000000000002"
	service.operations.graph = func(ctx context.Context, _ taskcore.GraphReader, _ taskcore.SnapshotClock, pid, id string, p model.Project) (model.TaskGraph, *model.Fault, error) {
		if ctx != t.Context() || pid != workProject || id != workGroup || p.ID != workProject {
			t.Fatal("wrong graph scope")
		}
		return model.TaskGraph{Project: p, ObservedAt: workTime, Tasks: []model.GraphTask{{ID: workGroup, Version: 1, Status: model.TaskDone}, {ID: child, Version: 1, Status: model.TaskInProgress, DependsOn: []string{workGroup, external}, ExternalDependsOn: []string{external}}, {ID: external, Version: 1, Status: model.TaskInProgress}}}, nil, nil
	}
	result, err := service.ObserveGraph(t.Context(), observationActor(), workProject, workGroup)
	if err != nil || result.Relations[external] != "external" || result.Relations[child] != "member" || result.Aggregation.WorkingCount != 1 || len(result.Sessions) != 3 {
		t.Fatalf("graph %#v %v", result, err)
	}
}
func TestObservedReadsRetainRefusalsAndNeverObserveRejectedTasks(t *testing.T) {
	service, _, observer, _ := workServiceFixture(t)
	refusal := &model.Fault{Code: "task_deleted", Message: "deleted"}
	service.operations.task = func(context.Context, taskcore.ReadDAO, string, string) (model.Task, *model.Fault, error) {
		return model.Task{}, refusal, nil
	}
	if _, err := service.ObserveGet(t.Context(), observationActor(), workProject, workGroup); !errors.Is(err, refusal) || observer.calls != 0 {
		t.Fatalf("refusal was hidden: %v calls=%d", err, observer.calls)
	}
	if _, err := service.ObserveGet(t.Context(), model.Principal{}, workProject, workGroup); err == nil {
		t.Fatal("accepted anonymous principal")
	}
	if _, err := service.ObserveGraph(t.Context(), observationActor(), workProject, "invalid"); err == nil {
		t.Fatal("accepted invalid task")
	}
	if _, err := service.ObservedMCPList(t.Context(), observationActor(), workProject, taskcore.MCPListRequest{Limit: 201}); err == nil {
		t.Fatal("accepted invalid MCP limit")
	}
}
