package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func scopedObservationAuth(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	p, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: observationActor(), Profile: model.ScopedPATProfile, Policy: &p}
}

func TestScopedObservationReadsSkipSessionSourcesAndPreservePagination(t *testing.T) {
	app, _, observer, database := workServiceFixture(t)
	snapshot := database.snapshot.(workServiceSnapshot)
	snapshot.sessions = nil
	database.snapshot = snapshot
	value := observationTask()
	value.Properties = model.TaskProperties{"worker": json.RawMessage(`{"nativeSessionId":"secret"}`)}
	app.operations.task = func(context.Context, taskcore.ReadDAO, string, string) (model.Task, *model.Fault, error) {
		return value, nil, nil
	}
	app.operations.list = func(context.Context, taskcore.ReadDAO, string, taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
		return store.TaskPage{Items: []model.Task{value}, HasMore: true}, nil, nil
	}
	app.operations.mcpList = func(context.Context, taskcore.MCPListReader, string, taskcore.MCPListSelection) (taskcore.MCPListPage, error) {
		return taskcore.MCPListPage{Items: []store.TaskPriorityItem{{Task: value}}, HasMore: true}, nil
	}
	s := NewScopedObservations(app, scopedObservationAuth(t, "task:read"))
	got, err := s.ObserveGet(t.Context(), observationActor(), workProject, workGroup)
	if err != nil || got.Session.Reason != "insufficient_scope" || got.Session.ObservedAt != nil || len(got.Task.Properties) != 0 {
		t.Fatalf("get %#v %v", got, err)
	}
	page, err := s.ObserveList(t.Context(), observationActor(), workProject, TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
	if err != nil || !page.Partial || page.NextCursor == nil || len(page.Items) != 1 || len(page.Items[0].Task.Properties) != 0 {
		t.Fatalf("list %#v %v", page, err)
	}
	mcp, err := s.ObservedMCPList(t.Context(), observationActor(), workProject, taskcore.MCPListRequest{Limit: 1})
	if err != nil || !mcp.Partial || mcp.NextCursor == nil || len(mcp.Items) != 1 || len(mcp.Items[0].Item.Task.Properties) != 0 {
		t.Fatalf("MCP %#v %v", mcp, err)
	}
	if observer.calls != 0 || app.authorization != nil {
		t.Fatalf("sampling or shared mutation: %d %#v", observer.calls, app.authorization)
	}
}

func TestScopedObservationDenialPrecedesTaskRead(t *testing.T) {
	app, _, _, _ := workServiceFixture(t)
	s := NewScopedObservations(app, scopedObservationAuth(t, "project:read"))
	_, err := s.ObserveGet(t.Context(), observationActor(), workProject, workGroup)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("read denial: %v", err)
	}
}

func TestScopedObservationWithSessionPermissionKeepsSampling(t *testing.T) {
	app, _, observer, _ := workServiceFixture(t)
	value := observationTask()
	app.operations.task = func(context.Context, taskcore.ReadDAO, string, string) (model.Task, *model.Fault, error) {
		return value, nil, nil
	}
	s := NewScopedObservations(app, scopedObservationAuth(t, "session:read", "task:read"))
	got, err := s.ObserveGet(t.Context(), observationActor(), workProject, workGroup)
	if err != nil || got.Session.Observation != "observed" || observer.calls != 1 {
		t.Fatalf("session projection %#v %v calls=%d", got, err, observer.calls)
	}
}

func TestScopedObservedGraphSummarizesVisibleActiveMembersWithoutSessions(t *testing.T) {
	app, _, observer, database := workServiceFixture(t)
	snapshot := database.snapshot.(workServiceSnapshot)
	snapshot.sessions = nil
	database.snapshot = snapshot
	app.operations.graph = func(_ context.Context, _ taskcore.GraphReader, _ taskcore.SnapshotClock, projectID, root string, project model.Project) (model.TaskGraph, *model.Fault, error) {
		if project.ID != projectID || project.Name != "" {
			t.Fatalf("project projection %#v", project)
		}
		return model.TaskGraph{Project: project, Tasks: []model.GraphTask{
			{ID: root, Status: model.TaskInProgress},
			{ID: taskReadScopeID(2), Status: model.TaskInProgress, DependsOn: []string{root}},
			{ID: taskReadScopeID(3), Status: model.TaskDone, DependsOn: []string{root}},
			{ID: taskReadScopeID(4), Status: model.TaskInProgress},
		}}, nil, nil
	}
	s := NewScopedObservations(app, scopedObservationAuth(t, "task:read"))
	got, err := s.ObserveGraphTaskOnly(t.Context(), observationActor(), workProject, workGroup)
	if err != nil || !got.Partial || got.Aggregation.Complete || got.Aggregation.UnknownCount != 2 || got.Aggregation.WorkingCount != 0 || got.Aggregation.ObservedAt != workTime || len(got.Sessions) != 4 || observer.calls != 0 {
		t.Fatalf("graph %#v %v calls=%d", got, err, observer.calls)
	}
	for _, value := range got.Sessions {
		if value.ObservedAt != nil || value.Reason != "insufficient_scope" {
			t.Fatalf("graph observation %#v", value)
		}
	}
	if _, err := s.ObserveGraph(t.Context(), observationActor(), workProject, workGroup); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("full graph refusal %v", err)
	}
}

func TestScopedWorkRetainsAllUnknownContributorsBeforePagination(t *testing.T) {
	app, reader, observer, database := workServiceFixture(t)
	snapshot := database.snapshot.(workServiceSnapshot)
	snapshot.sessions = nil
	database.snapshot = snapshot
	reader.groups = func(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
		return store.TaskWorkGroups{Items: []store.TaskWorkGroup{{ID: workGroup, DisplayTaskID: workGroup, MemberCount: 21, InProgressCount: 21, MatchedCount: 21, StartedAt: workTime}}, Targets: workKeys(workGroup, 21)}, nil
	}
	reader.targets = func(context.Context, string, []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
		items := make([]store.TaskWorkTarget, 21)
		for i := range items {
			task := observationTask()
			task.ID = taskReadScopeID(i)
			items[i] = store.TaskWorkTarget{GroupID: workGroup, Task: task}
		}
		return store.TaskWorkTargets{Items: items}, nil
	}
	s := NewScopedObservations(app, scopedObservationAuth(t, "task:read"))
	page, err := s.WorkList(t.Context(), observationActor(), workProject, taskcore.WorkRequest{})
	if err != nil || !page.Partial || len(page.Groups) != 1 {
		t.Fatalf("page %#v %v", page, err)
	}
	g := page.Groups[0]
	if g.Summary.UnknownCount != 21 || g.Summary.Complete || g.Summary.WorkingCount != 0 || len(g.Targets) != 20 || g.ContributorCursor == nil || observer.calls != 0 {
		t.Fatalf("group %#v observer=%d", g, observer.calls)
	}
	for _, v := range g.Targets {
		if v.SessionID != nil || v.Indicator != nil || v.Reason != "insufficient_scope" || v.Send.Allowed != nil || v.Send.Mode != nil {
			t.Fatalf("target %#v", v)
		}
	}
}

func taskReadScopeID(i int) string { return fmt.Sprintf("20000000-0000-4000-8000-%012d", i) }
