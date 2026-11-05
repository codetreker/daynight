package task

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type graphFixture struct {
	present   store.TaskPresence
	size      store.TaskGraphSize
	called    bool
	selection store.TaskGraphSelection
}

func (f *graphFixture) TaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	return f.present, nil
}
func (f *graphFixture) TaskGraphProjectionSize(_ context.Context, _, _ string, selection store.TaskGraphSelection) (store.TaskGraphSize, error) {
	f.selection = selection
	return f.size, nil
}
func (f *graphFixture) TaskGraphTasks(_ context.Context, _, _ string, _ store.TaskGraphSelection, _ int) ([]model.GraphTask, error) {
	f.called = true
	return []model.GraphTask{{Status: model.TaskTodo, Ready: true}}, nil
}

func TestReadGraphRefusalPrecedesProjection(t *testing.T) {
	ctx := context.Background()
	clock := func(context.Context) (time.Time, error) { return time.Unix(1, 0), nil }
	fixture := &graphFixture{present: store.TaskPresence{Found: true}, size: store.TaskGraphSize{NodeCount: 1001}}
	graph, refusal, err := ReadGraph(ctx, fixture, clock, "project", "task", model.Project{})
	if err != nil || refusal == nil || refusal.Code != "graph_limit_exceeded" || fixture.called || len(graph.Tasks) != 0 {
		t.Fatalf("limit refusal: %+v %+v %v", graph, refusal, err)
	}
	fixture.size.NodeCount = 1
	graph, refusal, err = ReadGraph(ctx, fixture, clock, "project", "task", model.Project{})
	if err != nil || refusal != nil || !fixture.called || graph.Summary.Ready != 1 || !fixture.selection.DirectExternal || !fixture.selection.OrdinaryDependents || !fixture.selection.OrdinaryPrerequisites || !fixture.selection.IncludeExternalEdges || !fixture.selection.LiveOnly {
		t.Fatalf("graph: %+v %+v %v", graph, refusal, err)
	}
	fixture.present.Found = false
	_, refusal, err = ReadGraph(ctx, fixture, clock, "project", "task", model.Project{})
	if err != nil || refusal == nil || !errors.Is(refusal, model.ErrNotFound) {
		t.Fatalf("root: %+v %v", refusal, err)
	}
}
