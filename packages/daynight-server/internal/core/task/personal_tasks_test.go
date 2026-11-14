package task

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestActivePersonalTaskWorker(t *testing.T) {
	claim := &model.WorkerClaim{State: model.WorkerActive, WorkerID: "worker", Machine: model.WorkerMachine{ID: "machine", Name: "name"}}
	worker := ActivePersonalTaskWorker(claim)
	if worker == nil || worker.WorkerID != claim.WorkerID || worker.Machine != claim.Machine {
		t.Fatalf("active worker: %#v", worker)
	}
	claim.State = model.WorkerCompleted
	if ActivePersonalTaskWorker(claim) != nil || ActivePersonalTaskWorker(nil) != nil {
		t.Fatal("inactive claim exposed")
	}
}

func TestPersonalTaskCursorAndRevision(t *testing.T) {
	actor := "00000000-0000-4000-8000-000000000001"
	selection, err := SelectPersonalTasks(actor, 0, nil)
	if err != nil || selection.Query.Limit != 50 {
		t.Fatalf("selection: %+v %v", selection, err)
	}
	facts := []store.PersonalTaskProject{{ID: "b", Name: "b", MatchedCount: "1", AllTaskCount: "2", AllTaskVersionSum: "9223372036854775808"}, {ID: "a", Name: "a", MatchedCount: "1"}}
	revision, err := PersonalTaskRevision(facts)
	if err != nil {
		t.Fatal(err)
	}
	reverse := []store.PersonalTaskProject{facts[1], facts[0]}
	got, _ := PersonalTaskRevision(reverse)
	if got != revision {
		t.Fatal("project order changed revision")
	}
	reverse[0].AllTaskVersionSum = "1"
	got, _ = PersonalTaskRevision(reverse)
	if got == revision {
		t.Fatal("task facts did not change revision")
	}
	pos := store.PersonalTaskPosition{ProjectName: "P", OwnerTeamKind: "personal", OwnerTeamID: actor, ProjectID: actor, TaskID: actor}
	token, err := selection.CursorAfter(revision, pos)
	if err != nil {
		t.Fatal(err)
	}
	next, err := SelectPersonalTasks(actor, 1, &token)
	if err != nil || next.Query.After == nil || *next.Query.After != pos {
		t.Fatalf("cursor: %+v %v", next, err)
	}
	if next.CheckRevision(revision) != nil || next.CheckRevision(strings.Repeat("a", 64)) == nil {
		t.Fatal("revision fence")
	}
	other := "00000000-0000-4000-8000-000000000002"
	if _, err := SelectPersonalTasks(other, 1, &token); err == nil {
		t.Fatal("actor mismatch accepted")
	}
	raw, _ := base64.RawURLEncoding.DecodeString(token)
	var c personalTaskCursor
	if err = json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*personalTaskCursor){func(c *personalTaskCursor) { c.Kind = "wrong" }, func(c *personalTaskCursor) { c.Version = 2 }, func(c *personalTaskCursor) { c.Position.TaskID = "x" }, func(c *personalTaskCursor) { c.Revision = "x" }, func(c *personalTaskCursor) { c.Position.OwnerTeamKind = "ordinary" }} {
		broken := c
		mutate(&broken)
		data, _ := json.Marshal(broken)
		v := base64.RawURLEncoding.EncodeToString(data)
		if _, err = SelectPersonalTasks(actor, 1, &v); err == nil {
			t.Fatalf("accepted cursor %s", data)
		}
	}
	bad := strings.Repeat("a", transportLimitForTest())
	if _, err = SelectPersonalTasks(actor, 1, &bad); err == nil {
		t.Fatal("accepted oversized cursor")
	}
	tm := time.Date(2026, 1, 1, 0, 0, 0, 1000, time.UTC)
	pos.StartedAt = &tm
	token, err = selection.CursorAfter(revision, pos)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = SelectPersonalTasks(actor, 1, &token); err != nil {
		t.Fatal(err)
	}
	if _, err = SelectPersonalTasks(actor, 101, nil); err == nil {
		t.Fatal("accepted oversized limit")
	}
}
func transportLimitForTest() int { return 100000 }
func TestPersonalTaskPaused(t *testing.T) {
	for _, tc := range []struct {
		raw  *string
		want bool
		fail bool
	}{{nil, false, false}, {pointerString("true"), true, false}, {pointerString("false"), false, false}, {pointerString("null"), false, true}, {pointerString(`"true"`), false, true}, {pointerString("true false"), false, true}} {
		got, err := PersonalTaskPaused(tc.raw)
		if got != tc.want || (err != nil) != tc.fail {
			t.Fatalf("%v: %v %v", tc.raw, got, err)
		}
	}
}
func pointerString(v string) *string { return &v }

func TestPersonalTaskCursorRejectsUnencodablePositions(t *testing.T) {
	actor := "00000000-0000-4000-8000-000000000001"
	selection, err := SelectPersonalTasks(actor, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	revision := strings.Repeat("a", 64)
	position := store.PersonalTaskPosition{ProjectName: "Project", OwnerTeamKind: "personal", OwnerTeamID: actor, ProjectID: actor, TaskID: actor}
	if _, err := selection.CursorAfter("bad", position); err == nil {
		t.Fatal("invalid revision encoded")
	}
	invalid := position
	invalid.TaskID = "invalid"
	if _, err := selection.CursorAfter(revision, invalid); err == nil {
		t.Fatal("invalid position encoded")
	}
	tooLate := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	invalid = position
	invalid.StartedAt = &tooLate
	if _, err := selection.CursorAfter(revision, invalid); err == nil {
		t.Fatal("unencodable time accepted")
	}
	invalid = position
	invalid.ProjectName = strings.Repeat("x", transportLimitForTest())
	if _, err := selection.CursorAfter(revision, invalid); err == nil {
		t.Fatal("oversized cursor emitted")
	}
}
