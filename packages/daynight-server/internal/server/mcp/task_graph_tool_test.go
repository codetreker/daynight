package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type graphStub struct {
	graph model.TaskGraph
	err   error
	actor model.Principal
}

func (s *graphStub) Graph(_ context.Context, p model.Principal, _, _ string) (model.TaskGraph, error) {
	s.actor = p
	return s.graph, s.err
}

func TestGraphToolCompleteProjectionAndErrors(t *testing.T) {
	reader := &graphStub{graph: model.TaskGraph{Summary: model.TaskGraphSummary{Total: 1, Proposed: 1}, Tasks: []model.GraphTask{{Status: model.TaskProposed, ID: "task", TitlePreview: "title", TitleTruncated: true, DependsOn: []string{"dependency"}}}}}
	actor := RequestActor{Principal: model.Principal{UserID: "caller"}, RequestID: "request"}
	result, err := graphTool(context.Background(), actor, graphInput{DependsOnly: true}, reader)
	if err != nil {
		t.Fatal(err)
	}
	graph := result.Data.(graphData)
	node := graph.Tasks[0].(dependencyNode)
	if graph.Summary.Proposed != 1 || graph.Summary.Total != 1 || graph.Projection != "summary" || node.ID != "task" || len(node.DependsOn) != 1 || reader.actor.UserID != "caller" {
		t.Fatalf("result: %#v", graph)
	}
	for i := 1; i < 70; i++ {
		reader.graph.Tasks = append(reader.graph.Tasks, model.GraphTask{ID: fmt.Sprint(i), TitlePreview: "title"})
	}
	for _, view := range []string{"summary", "full"} {
		result, err = graphTool(context.Background(), actor, graphInput{View: view}, reader)
		if err != nil {
			t.Fatal(err)
		}
		data := result.Data.(graphData)
		if data.Tasks[0].(graphNode).TitleTruncated != true || len(data.Tasks) != 70 || data.ReturnedNodes != 70 || data.TotalNodes != 70 {
			t.Fatalf("complete graph: %#v", data)
		}
		encoded, err := json.Marshal(envelope{Data: data, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil || len(encoded) <= 16<<10 {
			t.Fatalf("graph bytes=%d error=%v", len(encoded), err)
		}
	}
	reader.err = errors.New("graph read failed")
	result, err = graphTool(context.Background(), actor, graphInput{}, reader)
	if result.Data != nil || result.Refs != nil {
		t.Fatalf("partial graph: %#v", result)
	}
	if err != reader.err {
		t.Fatalf("lost graph failure: %v", err)
	}
}

func (s *graphStub) ObserveGraph(ctx context.Context, p model.Principal, project, id string) (taskservice.ObservedGraph, error) {
	graph, err := s.Graph(ctx, p, project, id)
	return observedGraphFixture(graph), err
}
