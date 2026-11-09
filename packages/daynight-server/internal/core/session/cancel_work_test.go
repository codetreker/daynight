package session

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestCancelWorkSignalsOperationsAndPreservesDisconnectAdmission(t *testing.T) {
	engine := &Engine{}
	first, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	for _, op := range []*Operation{first, second} {
		select {
		case <-op.Stopping():
			t.Fatal("operation was canceled before CancelWork")
		default:
		}
	}
	engine.CancelWork()
	engine.CancelWork()
	for _, op := range []*Operation{first, second} {
		select {
		case <-op.Stopping():
		default:
			t.Fatal("CancelWork did not signal an admitted operation")
		}
	}
	disconnect, err := engine.BeginOperation()
	if err != nil {
		t.Fatalf("disconnect admission after CancelWork: %v", err)
	}
	defer disconnect.Close()
	select {
	case <-disconnect.Stopping():
	default:
		t.Fatal("disconnect operation lost the cancellation signal")
	}
	committed := false
	disconnect.committed = append(disconnect.committed, func() { committed = true })
	disconnect.Finish(store.TransactionCommitted)
	if !committed {
		t.Fatal("CancelWork prevented the disconnect commit notification")
	}
	first.Close()
	second.Close()
	if err := engine.Stop(t.Context()); err != nil {
		t.Fatalf("Stop after canceled operations drained: %v", err)
	}
	if op, err := engine.BeginOperation(); err == nil {
		op.Close()
		t.Fatal("Stop left operation admission open")
	}
}

func TestCancelWorkBeforeAdmissionKeepsCancellationSignal(t *testing.T) {
	engine := &Engine{}
	engine.CancelWork()
	engine.CancelWork()
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatalf("CancelWork closed admission: %v", err)
	}
	defer op.Close()
	select {
	case <-op.Stopping():
	default:
		t.Fatal("first operation did not observe the earlier cancellation")
	}
	op.Close()
	if err := engine.Stop(t.Context()); err != nil {
		t.Fatalf("Stop after idle cancellation: %v", err)
	}
}
