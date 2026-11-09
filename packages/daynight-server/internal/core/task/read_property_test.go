package task

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestListSelectionCanonicalScopeAndOrdering(t *testing.T) {
	project := "abcdef00-0000-4000-8000-000000000001"
	actor := "abcdef00-0000-4000-8000-000000000002"
	worker := "ABCDEF00-0000-4000-8000-000000000003"
	me := "me"
	status := model.TaskTodo
	ready := true
	selection, err := SelectList(project, actor, ListRequest{PageRequest: model.PageRequest{Limit: 25}, AssignedTo: &me, WorkerID: &worker, Status: &status, Ready: &ready})
	if err != nil {
		t.Fatal(err)
	}
	if selection.Query.AssignedTo.Mode != model.TaskAssignmentUser || selection.Query.AssignedTo.UserID != actor || selection.Query.Worker.WorkerID != "abcdef00-0000-4000-8000-000000000003" || selection.Scope.WorkerUserID == nil || *selection.Scope.WorkerUserID != actor || selection.Query.Page.Limit != 25 {
		t.Fatalf("selection: %+v", selection)
	}
	badStatus := model.TaskStatus("unknown")
	_, err = SelectList(project, actor, ListRequest{PageRequest: model.PageRequest{Limit: 0}, Status: &badStatus})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Message != "Task status is invalid." {
		t.Fatalf("filter must fail before page: %v", err)
	}
}

func TestPropertyCandidatePreservesNoOpAndInput(t *testing.T) {
	value, err := PropertyInput("paused", "true")
	if err != nil {
		t.Fatal(err)
	}
	current := model.Task{Properties: model.TaskProperties{"paused": json.RawMessage("true")}}
	same, changed := SetPropertyCandidate(current, "paused", value)
	if changed {
		t.Fatal("same value changed task")
	}
	same.Properties["paused"][0] = 'f'
	if string(current.Properties["paused"]) != "true" {
		t.Fatal("candidate aliased task properties")
	}
	_, changed = RemovePropertyCandidate(current, "pullRequests")
	if changed {
		t.Fatal("absent removal changed task")
	}
	candidate, changed := RemovePropertyCandidate(current, "paused")
	if !changed || len(candidate.Properties) != 0 || len(current.Properties) != 1 {
		t.Fatal("removal changed source or missed change")
	}
	if _, err := PropertyInput("worker", "{}"); err == nil {
		t.Fatal("accepted protected property")
	}
	if err := CheckPropertyWritable("sessionStartup"); err == nil {
		t.Fatal("accepted protected removal")
	}
}
