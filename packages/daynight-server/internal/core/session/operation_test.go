package session

import (
	"context"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestOperationPublishesOnlyConfirmedCommit(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			engine := &Engine{now: time.Now, live: map[string]*liveCell{"id": {value: newLive(sp.Snapshot{Activity: "old"})}}}
			op, err := engine.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			draft, err := op.content("id", false)
			if err != nil {
				t.Fatal(err)
			}
			draft.Snapshot.Activity = "new"
			called := false
			discarded := false
			op.onDiscard(func() { discarded = true })
			op.committed = append(op.committed, func() {
				called = true
				if !engine.live["id"].mu.TryLock() {
					t.Fatal("hook ran before cell unlock")
				}
				engine.live["id"].mu.Unlock()
			})
			op.Finish(outcome)
			op.Close()
			want := "old"
			if outcome == store.TransactionCommitted {
				want = "new"
			}
			if got := engine.live["id"].value.Snapshot.Activity; got != want || called != (outcome == store.TransactionCommitted) || discarded != (outcome != store.TransactionCommitted) {
				t.Fatalf("activity = %q, hook = %v, discarded = %v", got, called, discarded)
			}
		})
	}
}

func TestOperationPanicAndDeletionDoNotRepublish(t *testing.T) {
	engine := &Engine{now: time.Now, live: map[string]*liveCell{"id": {value: newLive(sp.Snapshot{Activity: "old"})}}}
	func() {
		defer func() { _ = recover() }()
		op, err := engine.BeginOperation()
		if err != nil {
			t.Fatal(err)
		}
		defer op.Close()
		draft, err := op.content("id", false)
		if err != nil {
			t.Fatal(err)
		}
		draft.Snapshot.Activity = "uncommitted"
		panic("callback")
	}()
	if got := engine.live["id"].value.Snapshot.Activity; got != "old" {
		t.Fatalf("panic published %q", got)
	}
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := op.content("id", false); err != nil {
		t.Fatal(err)
	}
	engine.DiscardBotSession("id")
	op.Finish(store.TransactionCommitted)
	if _, exists := engine.live["id"]; exists {
		t.Fatal("late commit restored deleted cell")
	}
}

func TestStopWaitsForHooksAndRejectsNewOperations(t *testing.T) {
	engine := &Engine{}
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	op.committed = append(op.committed, func() { close(entered); <-release })
	go op.Finish(store.TransactionCommitted)
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := engine.Stop(ctx); err != context.DeadlineExceeded {
		t.Fatalf("Stop = %v", err)
	}
	if _, err := engine.BeginOperation(); err == nil {
		t.Fatal("work admitted after Stop")
	}
	close(release)
	if err := engine.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}
