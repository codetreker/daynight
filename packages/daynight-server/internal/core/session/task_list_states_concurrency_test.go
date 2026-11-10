package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type taskListReadResult struct {
	states map[string]model.SessionListState
	err    error
}

func awaitTaskListAdmission(t *testing.T, engine *Engine, want int) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		engine.admissionMutex.Lock()
		got := engine.activeOperations
		engine.admissionMutex.Unlock()
		if got == want {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("active operations = %d, want %d", got, want)
		case <-tick.C:
		}
	}
}

func assertTaskListCellWait(t *testing.T, engine *Engine, result <-chan taskListReadResult) {
	t.Helper()
	select {
	case got := <-result:
		t.Fatalf("reader crossed uncommitted cell: %#v, %v", got.states, got.err)
	case <-time.After(10 * time.Millisecond):
	}
	if !engine.liveMutex.TryLock() {
		t.Fatal("reader held registry lock while waiting for cell")
	}
	engine.liveMutex.Unlock()
}

func TestTaskListSamplerWaitsForCommittedValueAndKeepsDraftOwnership(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			now := time.Now().UTC()
			source, live := taskListSource(now)
			engine := NewEngine(nil)
			engine.live[source.Session.SessionID] = &liveCell{value: live}
			op, err := engine.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			defer op.Close()
			draft, err := op.content(source.Session.SessionID, false)
			if err != nil {
				t.Fatal(err)
			}
			draft.Snapshot.Activity = "waiting_input"
			result := make(chan taskListReadResult, 1)
			go func() {
				states, err := engine.TaskListSessionStates(t.Context(), []store.TaskSessionSource{source})
				result <- taskListReadResult{states, err}
			}()
			awaitTaskListAdmission(t, engine, 2)
			assertTaskListCellWait(t, engine, result)
			if len(op.cells) != 1 || len(op.live) != 1 || op.live[source.Session.SessionID] != draft {
				t.Fatal("reader stole writer draft ownership")
			}
			op.Finish(outcome)
			select {
			case got := <-result:
				want := model.SessionListWorking
				if outcome == store.TransactionCommitted {
					want = model.SessionListNotice
				}
				if got.err != nil || len(got.states) != 1 || got.states[source.TaskID] != want {
					t.Fatalf("states after %s: %#v, %v", outcome, got.states, got.err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("reader did not settle after writer outcome")
			}
			awaitTaskListAdmission(t, engine, 0)
		})
	}
}

func TestTaskListSamplerRejectsRemovedOrReplacedRegistryCell(t *testing.T) {
	for _, replacement := range []bool{false, true} {
		t.Run(map[bool]string{false: "removed", true: "replaced"}[replacement], func(t *testing.T) {
			now := time.Now().UTC()
			source, live := taskListSource(now)
			engine := NewEngine(nil)
			cell := &liveCell{value: live}
			engine.live[source.Session.SessionID] = cell
			cell.mu.Lock()
			locked := true
			defer func() {
				if locked {
					cell.mu.Unlock()
				}
			}()
			result := make(chan taskListReadResult, 1)
			go func() {
				states, err := engine.TaskListSessionStates(t.Context(), []store.TaskSessionSource{source})
				result <- taskListReadResult{states, err}
			}()
			awaitTaskListAdmission(t, engine, 1)
			assertTaskListCellWait(t, engine, result)
			engine.liveMutex.Lock()
			delete(engine.live, source.Session.SessionID)
			if replacement {
				engine.live[source.Session.SessionID] = &liveCell{value: live}
			}
			engine.liveMutex.Unlock()
			cell.mu.Unlock()
			locked = false
			select {
			case got := <-result:
				if got.err != nil || len(got.states) != 1 || got.states[source.TaskID] != model.SessionListWarning {
					t.Fatalf("stale registry state: %#v, %v", got.states, got.err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("registry change deadlocked reader")
			}
		})
	}
}

func TestTaskListSamplerCancellationAndStopWaitForOwnedCell(t *testing.T) {
	for _, stop := range []bool{false, true} {
		t.Run(map[bool]string{false: "request cancellation", true: "engine stop"}[stop], func(t *testing.T) {
			now := time.Now().UTC()
			source, live := taskListSource(now)
			engine := NewEngine(nil)
			cell := &liveCell{value: live}
			engine.live[source.Session.SessionID] = cell
			cell.mu.Lock()
			locked := true
			defer func() {
				if locked {
					cell.mu.Unlock()
				}
			}()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			result := make(chan taskListReadResult, 1)
			go func() {
				states, err := engine.TaskListSessionStates(ctx, []store.TaskSessionSource{source})
				result <- taskListReadResult{states, err}
			}()
			awaitTaskListAdmission(t, engine, 1)
			assertTaskListCellWait(t, engine, result)
			if stop {
				deadline, done := context.WithTimeout(t.Context(), 10*time.Millisecond)
				err := engine.Stop(deadline)
				done()
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("Stop did not wait for admitted reader: %v", err)
				}
			} else {
				cancel()
			}
			select {
			case got := <-result:
				t.Fatalf("mutex wait was detached from read ownership: %#v, %v", got.states, got.err)
			default:
			}
			cell.mu.Unlock()
			locked = false
			select {
			case got := <-result:
				if got.states != nil || got.err == nil {
					t.Fatalf("cancelled read published: %#v, %v", got.states, got.err)
				}
				if stop {
					var fault *model.Fault
					if !errors.As(got.err, &fault) || fault.Code != "service_unavailable" {
						t.Fatalf("stop error: %v", got.err)
					}
				} else if !errors.Is(got.err, context.Canceled) {
					t.Fatalf("cancel error: %v", got.err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("cancelled read did not settle after mutex release")
			}
			awaitTaskListAdmission(t, engine, 0)
			if err := engine.Stop(t.Context()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTaskListSamplerDoesNotPublishWhenAdmissionEndsDuringProjection(t *testing.T) {
	for _, stop := range []bool{false, true} {
		t.Run(map[bool]string{false: "request cancellation", true: "engine stop"}[stop], func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			engine := NewEngine(nil)
			engine.now = func() time.Time {
				if stop {
					engine.CancelWork()
				} else {
					cancel()
				}
				return time.Now()
			}
			got, err := engine.TaskListSessionStates(ctx, nil)
			if got != nil || err == nil {
				t.Fatalf("late admission loss published: %#v, %v", got, err)
			}
		})
	}
}

func TestTaskListSamplerCopiesScalarsWithoutOwningDrafts(t *testing.T) {
	now := time.Now().UTC()
	source, live := taskListSource(now)
	engine := NewEngine(nil)
	cell := &liveCell{value: live}
	engine.live[source.Session.SessionID] = cell
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	states, err := engine.readTaskSessionLiveStates(t.Context(), op, []store.TaskSessionSource{source, source})
	if err != nil || len(states) != 1 {
		t.Fatalf("scalar read: %#v, %v", states, err)
	}
	if len(op.cells) != 0 || len(op.live) != 0 || len(op.committed) != 0 {
		t.Fatal("read created draft or commit ownership")
	}
	if !cell.mu.TryLock() {
		t.Fatal("read retained a live-cell lock")
	}
	if cell.value != live {
		t.Fatal("read replaced committed cell")
	}
	live.Snapshot.Activity = "waiting_input"
	cell.mu.Unlock()
	if states[source.Session.SessionID].Activity != "working" {
		t.Fatal("returned scalar view aliases mutable live state")
	}
	op.Close()
	if err := engine.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
}
