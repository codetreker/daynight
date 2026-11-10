package projection

import (
	"errors"
	"reflect"
	"strings"
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

func TestAssigneeManifestPreservesLargeProfileVersionAndFutureWindow(t *testing.T) {
	const userID = "a1111111-1111-4111-8111-111111111111"
	const memberID = "c6666666-6666-4666-8666-666666666666"
	user, member := userID, memberID
	name := "Private profile name"
	avatar := "data:image/svg+xml;base64," + strings.Repeat("a", 235_600)
	facts := []model.TaskAssigneeFact{
		{UserID: userID, ProfileID: &user, HasProjectAccess: true, Qualified: true},
		{UserID: memberID, ProfileID: &member, Name: &name, AvatarURL: &avatar, HasProjectAccess: true, Qualified: true},
	}
	people, err := Catalogue(facts)
	if err != nil {
		t.Fatal(err)
	}
	if people.Items == nil || len(people.Items) != 2 || people.UnresolvedUserIDs == nil || len(people.UnresolvedUserIDs) != 0 {
		t.Fatalf("members without Tasks were omitted: %+v", people)
	}
	wantName := "Private profile name"
	wantAvatar := "data:image/svg+xml;base64," + strings.Repeat("a", 235_600)
	want := []model.TaskAssignee{
		{UserID: userID, Version: "c554c9691e1e5ad076b8c86c361ac25469470abf9bae8fc7d540c2e41bf60dee", HasProjectAccess: true},
		{UserID: memberID, Version: "1d34e2f377c506a34cfea8eca119d58ece7a39c19e447ccb3232f48cd3ea7f85", Name: &wantName, AvatarURL: &wantAvatar, HasProjectAccess: true},
	}
	if !reflect.DeepEqual(people.Items, want) {
		t.Fatalf("complete profile catalogue differs: got %+v, want %+v", people.Items, want)
	}
	versions := AssigneeVersions(people.Items)
	if versions == nil || len(versions) != 2 {
		t.Fatalf("manifest excluded members without Tasks: %+v", versions)
	}
	for index, id := range []string{userID, memberID} {
		if versions[index].UserID != id || len(versions[index].Version) != 64 || !versions[index].HasProjectAccess || versions[index].Version != people.Items[index].Version {
			t.Fatalf("manifest item %d differs from its ordered catalogue entry: %+v", index, versions[index])
		}
	}
	const epoch = "cccccc99-9999-4999-8999-999999999999"
	since := time.Date(9999, time.December, 31, 23, 59, 59, 0, time.UTC)
	mode, lower := SyncWindow(epoch, epoch, &since, 10*time.Second)
	wantLower := time.Date(9999, time.December, 31, 23, 59, 49, 0, time.UTC)
	if mode != "delta" || lower == nil || !lower.Equal(wantLower) || !since.Equal(time.Date(9999, time.December, 31, 23, 59, 59, 0, time.UTC)) {
		t.Fatalf("future delta overlap differs: mode=%q lower=%v since=%v", mode, lower, since)
	}
}
