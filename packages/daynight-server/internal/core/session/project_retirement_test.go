package session

import (
	"context"
	"fmt"
	"runtime"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
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
	for i := 0; i < 129; i++ {
		f.facts = append(f.facts, store.ProjectSessionRetirementFact{ID: fmt.Sprintf("%03d", i), Backend: "web", Lifecycle: "active"})
	}
	f.facts[0].Lifecycle = "archived"
	f.facts = append(f.facts, store.ProjectSessionRetirementFact{ID: "130", Backend: "herdr", ControlEpoch: "4", Control: []byte(`{"connectionEpoch":"2","controlEpoch":"4","state":"manual","availableActions":["acquire_control"]}`)})
	if err := RetireProject(context.Background(), f, "project"); err != nil {
		t.Fatal(err)
	}
	if len(f.batches) != 2 || len(f.batches[0]) != 128 || len(f.batches[1]) != 2 {
		t.Fatalf("unexpected batches: %v", len(f.batches))
	}
	if got := f.batches[0][0].SnapshotPatch["lifecycle"]; got != "archived" {
		t.Fatalf("archived lifecycle changed: %v", got)
	}
	p := f.batches[1][1]
	control := p.TerminalPatch["Control"].(*v2.ControlState)
	if control.State != "suspended" || control.Lease != nil || len(control.AvailableActions) != 0 || control.ControlEpoch != "5" {
		t.Fatalf("terminal remains usable: %+v", control)
	}
}

func TestProjectRetirementTicketsFenceDelayedPublishAndPreserveReplacements(t *testing.T) {
	s := NewEngine(nil)
	project := "project"
	other := "other"
	cell := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})}
	s.live["old"] = cell
	s.live["other"] = &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: other}})}
	request := &pendingContent{projectID: project, reply: make(chan contentReply, 1)}
	s.content.pending = map[string]*pendingContent{"pending": request}
	r := &terminalRecord{Envelope: v2.Envelope{SessionID: "terminal", ClaimID: "claim", ExecutionGeneration: "1"}, Owner: v2.Owner{ProjectID: project}, ConnectionEpoch: "1"}
	exec := &Execution{Engine: s}
	publish, _, err := exec.stageTerminalSnapshot(r, []byte("old"))
	if err != nil {
		t.Fatal(err)
	}
	ticket := s.CaptureProjectRetirement(project)
	publish()
	replacement := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: other}})}
	s.live["replacement"] = replacement
	ticket.Retire()
	if s.live["old"] != nil || s.live["other"] == nil || s.live["replacement"] != replacement || s.terminalFrames["terminal"] != nil {
		t.Fatal("ticket retired wrong objects or missed committed reservation")
	}
	if len(s.content.pending) != 0 {
		t.Fatal("content request retained")
	}
	if reply := <-request.reply; reply.err == nil {
		t.Fatal("content waiter was not released")
	}
	publish()
	if s.terminalFrames["terminal"] != nil {
		t.Fatal("late frame republished")
	}

	publish2, _, err := exec.stageTerminalSnapshot(r, []byte("captured"))
	if err != nil {
		t.Fatal(err)
	}
	ticket2 := s.CaptureProjectRetirement(project)
	publish3, _, err := exec.stageTerminalSnapshot(r, []byte("replacement"))
	if err != nil {
		t.Fatal(err)
	}
	publish2()
	publish3()
	ticket2.Retire()
	if got := s.terminalFrames["terminal"]; got == nil || string(got.raw) != "replacement" {
		t.Fatal("ticket removed new reservation")
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
