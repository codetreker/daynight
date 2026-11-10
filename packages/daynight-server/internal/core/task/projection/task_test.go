package projection

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestGraphSummary(t *testing.T) {
	summary := SummarizeGraph([]model.GraphTask{{Status: model.TaskProposed}, {Status: model.TaskTodo, Ready: true}, {Status: model.TaskTodo}, {Status: model.TaskInProgress}, {Status: model.TaskDone}, {Status: model.TaskCancelled}})
	if summary.Total != 6 || summary.Proposed != 1 || summary.Todo != 2 || summary.Ready != 1 || summary.Blocked != 1 || summary.InProgress != 1 || summary.Done != 1 || summary.Cancelled != 1 {
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

func TestGraphRootAndAssigneeProjection(t *testing.T) {
	if fault := GraphRoot(false, false); fault == nil || fault.Code != "not_found" || !errors.Is(fault, model.ErrNotFound) {
		t.Fatalf("missing root: %+v", fault)
	}
	if fault := GraphRoot(true, true); fault == nil || fault.Code != "task_deleted" || !errors.Is(fault, model.ErrTaskDeleted) {
		t.Fatalf("deleted root: %+v", fault)
	}
	if GraphRoot(true, false) != nil {
		t.Fatal("live root refused")
	}
	if ids, err := AssigneeUserIDs(nil); err != nil || ids != nil {
		t.Fatalf("catalogue selection: %v %v", ids, err)
	}
	if _, err := AssigneeUserIDs([]string{"invalid"}); err == nil {
		t.Fatal("accepted invalid ID")
	}
	id, name, avatar := "abcdef00-0000-4000-8000-000000000001", "Alice", "https://example.test/a"
	facts := []model.TaskAssigneeFact{{UserID: id, ProfileID: &id, Name: &name, AvatarURL: &avatar, HasProjectAccess: true}}
	result, err := Catalogue(facts)
	if err != nil || len(result.Items) != 1 || result.UnresolvedUserIDs == nil {
		t.Fatalf("catalogue: %+v %v", result, err)
	}
	versions := AssigneeVersions(result.Items)
	if len(versions) != 1 || versions[0].UserID != id || !versions[0].HasProjectAccess || versions[0].Version != result.Items[0].Version {
		t.Fatalf("version projection: %+v", versions)
	}
	changed := AssigneeContentVersion(id, nil, &avatar)
	if changed == versions[0].Version {
		t.Fatal("profile changes did not change version")
	}
	if mode, lower := SyncWindow(id, id, nil, time.Second); mode != "delta" || lower != nil {
		t.Fatalf("initial delta: %q %v", mode, lower)
	}
}

func TestResolveAssigneesRejectsInconsistentFacts(t *testing.T) {
	id := "abcdef00-0000-4000-8000-000000000001"
	other := "abcdef00-0000-4000-8000-000000000002"
	valid := model.TaskAssigneeFact{UserID: id, ProfileID: &id, Qualified: true}
	for _, facts := range [][]model.TaskAssigneeFact{
		{valid, valid},
		{{UserID: other}},
		{{UserID: id, Qualified: true}},
	} {
		if _, err := ResolveAssignees([]string{id}, facts); err == nil {
			t.Fatalf("accepted inconsistent facts: %+v", facts)
		}
	}
}
