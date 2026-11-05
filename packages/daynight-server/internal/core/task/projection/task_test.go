package projection

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestGraphLimitsAndSummary(t *testing.T) {
	if GraphLimit(1000, 5000) != nil {
		t.Fatal("limits are inclusive")
	}
	fault := GraphLimit(1001, 5001)
	if fault == nil || fault.GraphLimit.NodeCount != 1001 || fault.GraphLimit.MaxEdges != 5000 {
		t.Fatalf("limits: %+v", fault)
	}
	summary := SummarizeGraph([]model.GraphTask{{Status: model.TaskTodo, Ready: true}, {Status: model.TaskTodo}, {Status: model.TaskInProgress}, {Status: model.TaskDone}})
	if summary.Total != 4 || summary.Todo != 2 || summary.Ready != 1 || summary.Blocked != 1 || summary.InProgress != 1 || summary.Done != 1 {
		t.Fatalf("summary: %+v", summary)
	}
}

func TestSyncWindowAndValidation(t *testing.T) {
	epoch := "abcdef00-0000-4000-8000-000000000001"
	since := time.Date(2026, 11, 5, 0, 0, 0, 123, time.UTC)
	if err := ValidateSync("", &since); err == nil {
		t.Fatal("accepted since without epoch")
	}
	if err := ValidateSync("ABCDEF00-0000-4000-8000-000000000001", nil); err == nil {
		t.Fatal("accepted noncanonical epoch")
	}
	if err := ValidateSync(epoch, &since); err != nil {
		t.Fatal(err)
	}
	if mode, lower := SyncWindow(epoch, "different", &since, time.Second); mode != "snapshot" || lower != nil {
		t.Fatal("mismatched epoch not snapshot")
	}
	mode, lower := SyncWindow(epoch, epoch, &since, time.Second)
	if mode != "delta" || lower == nil || !lower.Equal(since.Add(-time.Second)) || !since.Equal(time.Date(2026, 11, 5, 0, 0, 0, 123, time.UTC)) {
		t.Fatal("delta overlap changed")
	}
}

func TestAssigneeResolutionCompleteness(t *testing.T) {
	id := "abcdef00-0000-4000-8000-000000000001"
	other := "abcdef00-0000-4000-8000-000000000002"
	ids, err := AssigneeUserIDs([]string{other, "ABCDEF00-0000-4000-8000-000000000001"})
	if err != nil || ids[0] != id || ids[1] != other {
		t.Fatalf("canonical ordering: %v %v", ids, err)
	}
	if _, err := AssigneeUserIDs([]string{id, "ABCDEF00-0000-4000-8000-000000000001"}); err == nil {
		t.Fatal("accepted canonical duplicate")
	}
	if _, err := AssigneeUserIDs([]string{}); err == nil {
		t.Fatal("accepted empty selection")
	}
	facts := []model.TaskAssigneeFact{{UserID: id, ProfileID: &id, HasProjectAccess: true, Qualified: true}, {UserID: other}}
	result, err := ResolveAssignees(ids, facts)
	if err != nil || len(result.Items) != 1 || len(result.UnresolvedUserIDs) != 1 || result.UnresolvedUserIDs[0] != other {
		t.Fatalf("resolution: %+v %v", result, err)
	}
	if _, err := ResolveAssignees(ids, facts[:1]); err == nil {
		t.Fatal("accepted missing row")
	}
	facts[1].Name = &id
	if _, err := ResolveAssignees(ids, facts); err == nil {
		t.Fatal("accepted unqualified profile")
	}
	if _, err := Catalogue([]model.TaskAssigneeFact{{UserID: id}}); err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatal("missing qualified profile must remain internal")
	}
}
