package session

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type terminalOperationFact struct {
	id    string
	value *store.TerminalOperation
}

type terminalOperationEpoch struct {
	id    string
	epoch int64
}

type terminalControlOperations struct {
	t                    *testing.T
	facts                []terminalOperationFact
	inserted             []store.TerminalOperation
	results              []v2.OperationResult
	epochs               []terminalOperationEpoch
	queued               []string
	pending              bool
	viewerPending        bool
	viewerUser           string
	viewerBrowser        string
	invalidationRequired bool
	expirationRequired   bool
	insertCalls          int
}

func newTerminalControlOperations(t *testing.T, f *terminalControlFixture) *terminalControlOperations {
	t.Helper()
	x := &terminalControlOperations{t: t, facts: []terminalOperationFact{}, queued: []string{}, pending: false, viewerPending: false, viewerUser: f.p.UserID, viewerBrowser: f.browser}
	checkSession := func(id string) {
		t.Helper()
		if id != f.message.SessionID {
			t.Fatalf("terminal DAO Session ID = %q, want %q", id, f.message.SessionID)
		}
	}
	f.dao.TerminalOperationFn = func(_ context.Context, id, operationID string) (store.TerminalOperation, error) {
		checkSession(id)
		fact := x.fact(operationID)
		if fact.value == nil {
			return store.TerminalOperation{}, model.ErrNotFound
		}
		return fixtureCopy(*fact.value), nil
	}
	f.dao.InsertTerminalOperationFn = func(_ context.Context, value store.TerminalOperation) error {
		checkSession(value.SessionID)
		fact := x.fact(value.OperationID)
		if fact.value != nil || len(x.inserted) != 0 {
			t.Fatal("unexpected duplicate TerminalOperation insertion")
		}
		if value.Result.OperationID != value.OperationID || value.Result.State != "queued" || value.Seq != f.terminal.Record(t).OperationSeq+1 || len(value.Hash) != 32 || !value.Deadline.Equal(f.now.Add(time.Duration(v2.InputTimeoutMillis)*time.Millisecond).Truncate(time.Microsecond)) {
			t.Fatalf("invalid terminal insertion DTO: %#v", value)
		}
		x.insertCalls++
		x.inserted = append(x.inserted, value)
		return nil
	}
	f.dao.SetTerminalOperationResultFn = func(_ context.Context, id string, result v2.OperationResult) error {
		checkSession(id)
		x.operation(result.OperationID)
		if slices.ContainsFunc(x.results, func(value v2.OperationResult) bool { return value.OperationID == result.OperationID }) {
			t.Fatal("extra result write in the selected operation phase")
		}
		x.results = append(x.results, result)
		return nil
	}
	f.dao.SetSessionOperationEpochFn = func(_ context.Context, id, operationID string, epoch int64) error {
		checkSession(id)
		if epoch != number(f.terminal.Record(t).ConnectionEpoch) {
			t.Fatalf("unexpected dispatch epoch: %d", epoch)
		}
		x.operation(operationID)
		if slices.ContainsFunc(x.epochs, func(value terminalOperationEpoch) bool { return value.id == operationID }) {
			t.Fatal("extra epoch write in the selected operation phase")
		}
		x.epochs = append(x.epochs, terminalOperationEpoch{id: operationID, epoch: epoch})
		return nil
	}
	f.dao.QueuedTerminalOperationFn = func(_ context.Context, id string) ([]string, error) {
		checkSession(id)
		return slices.Clone(x.queued), nil
	}
	f.dao.TerminalInputPendingFn = func(_ context.Context, id string) (bool, error) {
		checkSession(id)
		return x.pending, nil
	}
	f.dao.TerminalViewerOperationPendingFn = func(_ context.Context, id, user, browser string) (bool, error) {
		checkSession(id)
		if user != x.viewerUser || browser != x.viewerBrowser {
			t.Fatalf("viewer pending query actor/browser = %s/%s, want %s/%s", user, browser, x.viewerUser, x.viewerBrowser)
		}
		return x.viewerPending, nil
	}
	f.dao.InvalidateTerminalOperationsFn = func(_ context.Context, id string) error {
		checkSession(id)
		x.invalidationRequired = false
		return nil
	}
	f.dao.ExpireTerminalOperationsFn = func(_ context.Context, id string, now time.Time) error {
		checkSession(id)
		if !now.Equal(f.now) {
			t.Fatalf("expiry check time = %v, want %v", now, f.now)
		}
		x.expirationRequired = false
		return nil
	}
	t.Cleanup(func() { x.checkRequired() })
	return x
}

func (x *terminalControlOperations) expect(operationID string) {
	if slices.ContainsFunc(x.facts, func(f terminalOperationFact) bool { return f.id == operationID }) {
		return
	}
	x.facts = append(x.facts, terminalOperationFact{id: operationID})
}

func (x *terminalControlOperations) fact(operationID string) *terminalOperationFact {
	x.t.Helper()
	for i := range x.facts {
		if x.facts[i].id == operationID {
			return &x.facts[i]
		}
	}
	x.t.Fatalf("unconfigured terminal operation lookup: %q", operationID)
	return nil
}

func (x *terminalControlOperations) operation(operationID string) *store.TerminalOperation {
	x.t.Helper()
	fact := x.fact(operationID)
	if fact.value == nil {
		x.t.Fatalf("terminal operation was not inserted: %q", operationID)
	}
	return fact.value
}

func (x *terminalControlOperations) resetWrites() {
	x.inserted = nil
	x.results = nil
	x.epochs = nil
}

func (x *terminalControlOperations) checkRequired() {
	x.t.Helper()
	if x.invalidationRequired || x.expirationRequired {
		x.t.Fatal("configured terminal Store operation was not invoked")
	}
}

func (x *terminalControlOperations) insertedInput(operationID string) {
	x.t.Helper()
	if len(x.inserted) != 1 || x.inserted[0].OperationID != operationID {
		x.t.Fatalf("insert captures = %#v, want one operation %s", x.inserted, operationID)
	}
	value := fixtureCopy(x.inserted[0])
	x.fact(operationID).value = &value
}

func (x *terminalControlOperations) resultInput(operationID string) {
	x.t.Helper()
	result := x.resultWrite(operationID)
	value := fixtureCopy(*x.operation(operationID))
	value.Result = result
	x.fact(operationID).value = &value
}

func (x *terminalControlOperations) resultWrite(operationID string) v2.OperationResult {
	x.t.Helper()
	for _, result := range x.results {
		if result.OperationID == operationID {
			return result
		}
	}
	x.t.Fatalf("missing result write for operation %s", operationID)
	return v2.OperationResult{}
}

func (x *terminalControlOperations) dispatchInput(operationID string) {
	x.resultInput(operationID)
	for _, value := range x.epochs {
		if value.id == operationID {
			input := fixtureCopy(*x.operation(operationID))
			epoch := value.epoch
			input.Epoch = &epoch
			x.fact(operationID).value = &input
			return
		}
	}
	x.t.Fatalf("missing dispatch epoch write for operation %s", operationID)
}

func (x *terminalControlOperations) whenInvalidated(operationID, state, code string) {
	value := fixtureCopy(*x.operation(operationID))
	value.Result = terminalResult(operationID, state, code)
	x.fact(operationID).value = &value
	x.queued = nil
	x.pending = false
	x.invalidationRequired = true
}

func (x *terminalControlOperations) whenExpired(operationID, state, code string) {
	value := fixtureCopy(*x.operation(operationID))
	value.Result = terminalResult(operationID, state, code)
	x.fact(operationID).value = &value
	x.queued = nil
	x.pending = false
	x.expirationRequired = true
}
