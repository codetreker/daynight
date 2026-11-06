package mcp

import (
	"context"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

func TestGraphToolProjectionAndBudget(t *testing.T) {
	reader := &graphStub{graph: model.TaskGraph{Tasks: []model.GraphTask{{ID: "task", TitlePreview: "title", TitleTruncated: true, DependsOn: []string{"dependency"}}}}}
	actor := RequestActor{Principal: model.Principal{UserID: "caller"}, RequestID: "request"}
	result, err := graphTool(context.Background(), actor, graphInput{DependsOnly: true}, reader)
	if err != nil {
		t.Fatal(err)
	}
	graph := result.Data.(graphData)
	node := graph.Tasks[0].(dependencyNode)
	if graph.Projection != "summary" || node.ID != "task" || len(node.DependsOn) != 1 || reader.actor.UserID != "caller" {
		t.Fatalf("result: %#v", graph)
	}
	reader.graph.Tasks[0].TitlePreview = strings.Repeat("a", 17000)
	result, err = graphTool(context.Background(), actor, graphInput{}, reader)
	if err != nil {
		t.Fatal(err)
	}
	truncated := result.Data.(graphData)
	if !truncated.Truncated || truncated.ReadFull == nil || truncated.ReturnedNodes != 0 || truncated.TotalNodes != 1 {
		t.Fatalf("truncated graph: %#v", truncated)
	}

	result, err = graphTool(context.Background(), actor, graphInput{View: "full"}, reader)
	if err != nil || result.Data.(graphData).Tasks[0].(graphNode).TitleTruncated != true || result.Data.(graphData).ReturnedNodes != 1 || result.Data.(graphData).TotalNodes != 1 {
		t.Fatalf("full graph: %#v, %v", result, err)
	}
	reader.err = &model.Fault{Code: "graph_limit_exceeded", GraphLimit: &model.GraphLimitDetails{NodeCount: 1001, EdgeCount: 5001, MaxNodes: 1000, MaxEdges: 5000}}
	result, err = graphTool(context.Background(), actor, graphInput{}, reader)
	if result.Refs["nodeCount"] != int64(1001) || result.Refs["maxEdges"] != int64(5000) {
		t.Fatalf("limits lost: %#v", result.Refs)
	}
	if err != reader.err {
		t.Fatalf("lost graph failure: %v", err)
	}
}
