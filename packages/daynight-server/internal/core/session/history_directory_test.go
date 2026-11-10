package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTaskHistoryCurrentNeverUsesHistoricalDirectory(t *testing.T) {
	f, v := connectFixture(t)
	prepareHistoryReads(f)
	for _, scenario := range []string{"registered", "not_registered", "no_worker", "herdr", "storage_error"} {
		t.Run(scenario, func(t *testing.T) {
			original := f.data.Task.Worker
			defer func() { f.data.Task.Worker = original }()
			f.data.CurrentSessionError = nil
			f.data.CurrentSessionID = v.SessionID
			expected := "registered"
			work := map[string]int{"CurrentTaskSession": 1}
			if scenario == "not_registered" {
				f.data.CurrentSessionError = model.ErrNotFound
				expected = "not_registered"
			}
			if scenario == "no_worker" {
				f.data.Task.Worker = nil
				work = nil
				expected = "not_applicable"
			}
			if scenario == "storage_error" {
				f.data.CurrentSessionError = errors.New("offline")
			}
			if scenario == "herdr" {
				worker := *original
				worker.AgentControlMode = model.AgentControlModeHerdr
				f.data.Task.Worker = &worker
				work = map[string]int{"CurrentTerminalSession": 1}
				f.dao.CurrentTerminalSessionFn = func(context.Context, string, string, string) (string, error) { return v.SessionID, nil }
			}
			phase := f.TaskPhase(t.Context(), work)
			out, err := f.s.TaskCurrentIdentity(phase, f.p, f.project, f.task)
			f.dao.FinishContext(phase)
			if scenario == "storage_error" {
				if err == nil {
					t.Fatal("storage failure lost")
				}
				return
			}
			if err != nil || out.Status != expected {
				t.Fatalf("current %#v %v", out, err)
			}
			if expected != "registered" && out.SessionID != nil {
				t.Fatal("current fell back to history")
			}
		})
	}
}
func TestTaskHistoryDirectoryPreservesOldClaimAndCurrentBinding(t *testing.T) {
	f, v := connectFixture(t)
	prepareHistoryReads(f)
	old := uuid.NewString()
	now := time.Now().UTC()
	rows := []store.TerminalHistoryRow{{ID: v.SessionID, Claim: v.ClaimID, Backend: "web", Created: now, Snapshot: encode(v)}, {ID: old, Claim: uuid.NewString(), Backend: "web", Created: now.Add(-time.Second), Snapshot: encode(v)}}
	f.dao.TerminalHistoryFn = func(_ context.Context, project, task string, before *time.Time, beforeID *string, limit int) ([]store.TerminalHistoryRow, error) {
		if project != f.project || task != f.task || limit != 2 {
			t.Fatal("directory query scope changed")
		}
		if before == nil {
			return rows, nil
		}
		if beforeID == nil || *beforeID != v.SessionID {
			t.Fatal("directory cursor changed")
		}
		return rows[1:], nil
	}
	phase := f.TaskPhase(t.Context(), map[string]int{"TerminalHistory": 1})
	page, err := f.s.TaskDirectory(phase, f.p, f.project, f.task, "", 1)
	f.dao.FinishContext(phase)
	if err != nil || len(page.Items) != 1 || !page.Items[0].CurrentBinding || page.NextCursor == nil {
		t.Fatalf("directory %#v %v", page, err)
	}
	phase = f.TaskPhase(t.Context(), map[string]int{"TerminalHistory": 1})
	older, err := f.s.TaskDirectory(phase, f.p, f.project, f.task, *page.NextCursor, 1)
	f.dao.FinishContext(phase)
	if err != nil || len(older.Items) != 1 || older.Items[0].SessionID != old || older.Items[0].CurrentBinding {
		t.Fatalf("older %#v %v", older, err)
	}
}
func TestTaskReadBindingRejectsScopeAndClaimChanges(t *testing.T) {
	f, v := connectFixture(t)
	op, _ := f.s.BeginOperation()
	defer op.Close()
	a := &Access{record: &record{Snapshot: v}}
	task := &TaskAccess{task: task{Worker: f.data.Task.Worker, Status: "in_progress"}}
	if err := op.BindTaskRead(a, task, f.project, f.task); err != nil {
		t.Fatal(err)
	}
	if a.write {
		t.Fatal("read grants write permission")
	}
	for _, mutate := range []func(*sp.Snapshot){func(v *sp.Snapshot) { v.ClaimID = uuid.NewString() }, func(v *sp.Snapshot) { v.Identity.TaskID = uuid.NewString() }, func(v *sp.Snapshot) { v.TestExecutionID = uuid.NewString() }} {
		bad := v
		mutate(&bad)
		a.record.Snapshot = bad
		if err := op.BindTaskRead(a, task, f.project, f.task); err == nil {
			t.Fatal("changed binding accepted")
		}
	}
}
