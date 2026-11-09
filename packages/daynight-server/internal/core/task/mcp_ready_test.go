package task

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestMCPReadySelection(t *testing.T) {
	allow := true
	platform := model.PlatformLinux
	for _, limit := range []int{1, 5, 20} {
		query, err := SelectMCPReady(MCPReadyRequest{Limit: limit, AllowAgents: &allow, CompatiblePlatform: &platform, View: "full"})
		if err != nil {
			t.Fatal(err)
		}
		if query.Limit != limit || query.Status == nil || *query.Status != model.TaskTodo || query.Ready == nil || !*query.Ready || query.AllowAgents != &allow || query.CompatiblePlatform != &platform || query.AssignedTo.Mode != model.TaskAssignmentAll || query.After != nil {
			t.Fatalf("candidate query: %#v", query)
		}
	}
	invalidPlatform := model.TaskPlatform("invalid")
	for _, request := range []MCPReadyRequest{
		{Limit: 0, View: "summary"}, {Limit: 21, View: "summary"},
		{Limit: 1, View: "other"}, {Limit: 1, View: "summary", CompatiblePlatform: &invalidPlatform},
	} {
		if _, err := SelectMCPReady(request); err == nil {
			t.Fatalf("accepted invalid request: %#v", request)
		}
	}
}
