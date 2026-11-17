package session

import (
	"context"
	"fmt"
	"runtime"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type retirementFixture struct {
	facts   []store.ProjectSessionRetirementFact
	batches [][]store.ProjectSessionRetirementPlan
}

func (f *retirementFixture) LockProjectSessions(_ context.Context, _, after string, limit int) ([]store.ProjectSessionRetirementFact, error) {
	if limit != 128 {
		panic("unexpected batch size")
	}
	var out []store.ProjectSessionRetirementFact
	for _, fact := range f.facts {
		if fact.ID > after && len(out) < limit {
			out = append(out, fact)
		}
	}
	return out, nil
}
func (f *retirementFixture) ApplyProjectSessionRetirement(_ context.Context, plans []store.ProjectSessionRetirementPlan) error {
	f.batches = append(f.batches, plans)
	return nil
}
func TestProjectRetirementBatchesAndRetainsHistoricalState(t *testing.T) {
	f := &retirementFixture{}
	// A complete page of historical rows must not stop later Web retirement.
	for i := 0; i < 128; i++ {
		f.facts = append(f.facts, store.ProjectSessionRetirementFact{ID: fmt.Sprintf("%03d", i), Backend: "herdr"})
	}
	f.facts = append(f.facts, store.ProjectSessionRetirementFact{ID: "128", Backend: "web", Lifecycle: "archived"}, store.ProjectSessionRetirementFact{ID: "129", Backend: "web", Lifecycle: "active"})
	if err := RetireProject(context.Background(), f, "project"); err != nil {
		t.Fatal(err)
	}
	if len(f.batches) != 1 || len(f.batches[0]) != 2 {
		t.Fatalf("unexpected batches: %v", f.batches)
	}
	if got := f.batches[0][0].SnapshotPatch["lifecycle"]; got != "archived" {
		t.Fatalf("archived lifecycle changed: %v", got)
	}
	if got := f.batches[0][1].SnapshotPatch["lifecycle"]; got != "draining" {
		t.Fatalf("active lifecycle not drained: %v", got)
	}
	for _, plan := range f.batches[0] {
		if plan.Backend != "web" {
			t.Fatalf("historical terminal scheduled for mutation: %+v", plan)
		}
	}
}

func TestProjectRetirementTicketsPreserveReplacements(t *testing.T) {
	s := NewEngine(nil)
	project := "project"
	other := "other"
	cell := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})}
	s.live["old"] = cell
	s.live["other"] = &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: other}})}
	request := &pendingContent{projectID: project, reply: make(chan contentReply, 1)}
	s.content.pending = map[string]*pendingContent{"pending": request}
	ticket := s.CaptureProjectRetirement(project)
	replacement := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: other}})}
	s.live["replacement"] = replacement
	ticket.Retire()
	if s.live["old"] != nil || s.live["other"] == nil || s.live["replacement"] != replacement {
		t.Fatal("ticket retired wrong objects")
	}
	if len(s.content.pending) != 0 {
		t.Fatal("content request retained")
	}
	if reply := <-request.reply; reply.err == nil {
		t.Fatal("content waiter was not released")
	}

}

func TestProjectRetirementWaitsForLateLivePublication(t *testing.T) {
	s := NewEngine(nil)
	project := "project"
	cell := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})}
	s.live["session"] = cell
	op, err := s.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	draft, err := op.content("session", false)
	if err != nil {
		t.Fatal(err)
	}
	draft.Synced = true
	started := make(chan struct{})
	done := make(chan *ProjectRetirementTicket, 1)
	go func() { close(started); done <- s.CaptureProjectRetirement(project) }()
	<-started
	deadline := time.After(5 * time.Second)
	for {
		if !s.liveMutex.TryLock() {
			break
		}
		s.liveMutex.Unlock()
		select {
		case <-deadline:
			t.Fatal("capture did not wait for held cell")
		default:
			runtime.Gosched()
		}
	}
	select {
	case <-done:
		t.Fatal("capture passed the pending cell publication")
	default:
	}
	op.Finish(store.TransactionCommitted)
	var ticket *ProjectRetirementTicket
	select {
	case ticket = <-done:
	case <-deadline:
		t.Fatal("capture did not finish")
	}
	ticket.Retire()
	s.liveMutex.Lock()
	published := s.live["session"]
	s.liveMutex.Unlock()
	if published != nil {
		t.Fatal("late committed cell survived retirement")
	}
}
