package task

import (
	"encoding/base64"
	"encoding/json"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestWorkSelectionBindsActorAssigneeAndGraphFence(t *testing.T) {
	const project = "00000000-0000-4000-8000-000000000001"
	const actor = "00000000-0000-4000-8000-000000000002"
	const group = "00000000-0000-4000-8000-000000000003"
	selected, err := SelectWork(project, actor, WorkRequest{})
	if err != nil || selected.Query.Limit != 20 || selected.Query.AssignedTo != actor {
		t.Fatalf("default selection: %#v %v", selected, err)
	}
	fence := store.TaskSearchFence{Epoch: project, Count: "3", VersionSum: "12"}
	cursor, err := selected.CursorAfter(fence, store.TaskWorkPosition{StartedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), GroupID: group})
	if err != nil {
		t.Fatal(err)
	}
	next, err := SelectWork(project, actor, WorkRequest{Cursor: &cursor})
	if err != nil || next.Query.After == nil {
		t.Fatalf("continuation: %#v %v", next, err)
	}
	if err := next.CheckFence(fence); err != nil {
		t.Fatal(err)
	}
	changed := fence
	changed.VersionSum = "13"
	if err := next.CheckFence(changed); err == nil || err.(*model.Fault).Code != "reset_required" {
		t.Fatalf("changed graph: %v", err)
	}
	other := "00000000-0000-4000-8000-000000000004"
	if _, err := SelectWork(project, other, WorkRequest{Cursor: &cursor}); err == nil {
		t.Fatal("cursor crossed actor")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(cursor)
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	body["extra"] = true
	raw, _ = json.Marshal(body)
	invalid := base64.RawURLEncoding.EncodeToString(raw)
	if _, err := SelectWork(project, actor, WorkRequest{Cursor: &invalid}); err == nil {
		t.Fatal("accepted unknown cursor field")
	}
}

func TestWorkRequestRefusesAmbiguousContinuation(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	unassigned := "unassigned"
	cursor := "bad"
	for _, input := range []WorkRequest{{AssignedTo: &unassigned}, {Limit: 51}, {GroupID: &id}, {TargetsCursor: &cursor}, {Cursor: &cursor, GroupID: &id, TargetsCursor: &cursor}} {
		if _, err := SelectWork(id, id, input); err == nil {
			t.Fatalf("accepted %#v", input)
		}
	}
}

func TestWorkPageBudgetPreservesContinuationAndUnknownCounts(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	selection, err := SelectWork(id, id, WorkRequest{})
	if err != nil {
		t.Fatal(err)
	}
	fence := store.TaskSearchFence{Epoch: id, Count: "2", VersionSum: "2"}
	now := time.Now().UTC()
	good := "working"
	summary := NewSessionAggregation(now)
	AddSessionObservation(&summary, sp.TaskSessionObservation{Observation: "observed", Indicator: &good})
	AddSessionObservation(&summary, sp.TaskSessionObservation{Observation: "unavailable"})
	if summary.Complete || summary.UnknownCount != 1 || summary.WorkingCount != 1 || summary.Indicator == nil || *summary.Indicator != "working" {
		t.Fatalf("partial aggregation: %#v", summary)
	}
	groups := []taskwork.Group{{GroupID: id, Roots: []taskwork.Root{}, Targets: []taskwork.Target{{TaskID: id, Reason: strings.Repeat("x", 2000)}}}, {GroupID: "00000000-0000-4000-8000-000000000002", Roots: []taskwork.Root{}, Targets: []taskwork.Target{{TaskID: id, Reason: strings.Repeat("x", 2000)}}}}
	positions := map[string]store.TaskWorkPosition{}
	for _, g := range groups {
		positions[g.GroupID] = store.TaskWorkPosition{GroupID: g.GroupID, StartedAt: now}
	}
	page := taskwork.Page{Groups: groups, ObservedAt: now}
	fitted, err := FitWorkPage(page, selection, fence, positions, 3500)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(fitted)
	if len(encoded) > 3500 || len(fitted.Groups) != 1 || fitted.NextCursor == nil {
		t.Fatalf("page cutoff: %d %#v", len(encoded), fitted)
	}
	next, err := SelectWork(id, id, WorkRequest{Cursor: fitted.NextCursor})
	if err != nil || next.Query.After.GroupID != id {
		t.Fatalf("wrong cutoff cursor: %#v %v", next, err)
	}
}

func TestWorkProjectionKeepsOwnersAndExternalGraphRelations(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	group := store.TaskWorkGroup{ID: "root", DisplayTaskID: "root", TitlePreview: "Done parent", MemberCount: 3, MatchedCount: 1, InProgressCount: 2, RootCount: 6, Roots: []store.TaskWorkRoot{{ID: "root", TitlePreview: "Done parent"}}}
	projected := ProjectWorkGroup(group, "actor", now)
	if projected.Kind != "chain" || !projected.RootsTruncated || len(projected.Roots) != 1 || projected.AggregationScope != "accessible_in_progress_members" || projected.Summary.ObservedAt != now {
		t.Fatalf("group: %#v", projected)
	}
	group.MemberCount = 1
	if got := ProjectWorkGroup(group, "actor", now); got.Kind != "task" {
		t.Fatalf("isolated task: %#v", got)
	}
	other, session, indicator, allowed, mode := "other", "session", "warning", false, "start"
	target := ProjectWorkTarget(model.Task{ID: "task", AssignedTo: &other}, "actor", sp.TaskSessionObservation{SessionID: &session, Indicator: &indicator, Reason: "idle", Send: sp.TaskSessionSend{Allowed: &allowed, Mode: &mode, Reason: "not_owner"}})
	if target.MatchesAssignee || target.AssignedTo == nil || *target.AssignedTo != "other" || target.SessionID == nil || *target.SessionID != session || target.Send.Allowed == nil || *target.Send.Allowed {
		t.Fatalf("target ownership: %#v", target)
	}
	graph := model.TaskGraph{Tasks: []model.GraphTask{
		{ID: "root", Status: model.TaskDone},
		{ID: "child", Status: model.TaskInProgress, DependsOn: []string{"root", "external"}, ExternalDependsOn: []string{"external"}},
		{ID: "leaf", Status: model.TaskInProgress, DependsOn: []string{"child"}},
		{ID: "external", Status: model.TaskInProgress},
	}}
	relations := GraphRelations(graph, "child")
	if len(relations) != 4 || relations["root"] != "member" || relations["leaf"] != "member" || relations["external"] != "external" {
		t.Fatalf("relations: %#v", relations)
	}
	summary := NewSessionAggregation(now)
	for _, label := range []string{"working", "notice", "warning"} {
		AddSessionObservation(&summary, sp.TaskSessionObservation{Observation: "observed", Indicator: &label})
		if summary.Indicator == nil || *summary.Indicator != label {
			t.Fatalf("priority %s: %#v", label, summary)
		}
	}
	if !summary.Complete || summary.WorkingCount != 1 || summary.NoticeCount != 1 || summary.WarningCount != 1 || summary.UnknownCount != 0 {
		t.Fatalf("counts: %#v", summary)
	}
}

func TestWorkTargetBudgetContinuationBindsTargetAndAssignee(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	const other = "00000000-0000-4000-8000-000000000002"
	selection, err := SelectWork(id, id, WorkRequest{})
	if err != nil {
		t.Fatal(err)
	}
	fence := store.TaskSearchFence{Epoch: id, Count: "2", VersionSum: "2"}
	page := taskwork.Page{Groups: []taskwork.Group{{GroupID: id, Roots: []taskwork.Root{}, Targets: []taskwork.Target{{TaskID: id, Reason: strings.Repeat("x", 2000)}, {TaskID: other, Reason: strings.Repeat("x", 2000)}}}}, ObservedAt: time.Now().UTC()}
	fitted, err := FitWorkPage(page, selection, fence, nil, 3500)
	if err != nil || len(fitted.Groups) != 1 || len(fitted.Groups[0].Targets) != 1 || fitted.Groups[0].ContributorCursor == nil {
		t.Fatalf("target cutoff: %#v %v", fitted, err)
	}
	group := id
	next, err := SelectWork(id, id, WorkRequest{GroupID: &group, TargetsCursor: fitted.Groups[0].ContributorCursor})
	if err != nil || next.AfterTarget == nil || next.AfterTarget.TaskID != id || next.AfterTarget.GroupID != id {
		t.Fatalf("target continuation: %#v %v", next, err)
	}
	for _, input := range []WorkRequest{{AssignedTo: workString(other), GroupID: &group, TargetsCursor: fitted.Groups[0].ContributorCursor}, {GroupID: workString(other), TargetsCursor: fitted.Groups[0].ContributorCursor}, {Cursor: fitted.Groups[0].ContributorCursor}} {
		if _, err := SelectWork(id, id, input); err == nil {
			t.Fatalf("cross-scope cursor accepted: %#v", input)
		}
	}
	if _, err := FitWorkPage(fitted, selection, fence, nil, 10); err == nil {
		t.Fatal("single target exceeded complete response budget")
	}
}

func workString(v string) *string { return &v }
