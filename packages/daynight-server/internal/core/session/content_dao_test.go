package session

import (
	"bytes"
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type contentOperationResponses struct {
	values   map[string]*store.SessionOperation
	inserts  map[string]store.SessionOperation
	receipts map[string]sp.Operation
	epochs   map[string]int64
	accepted []string
	pending  int
}

func contentCaseCalls(applies bool) int {
	if applies {
		return 1
	}
	return 0
}

func (responses *contentOperationResponses) useProposedResponse(id string, deadline time.Time) {
	value := responses.values[id]
	if value == nil {
		proposed, exists := responses.inserts[id]
		if !exists {
			panic("operation response selected before its write was observed")
		}
		value = &proposed
	}
	next := *value
	next.Deadline = deadline
	if receipt, observed := responses.receipts[id]; observed {
		next.Receipt = receipt
	}
	if epoch, observed := responses.epochs[id]; observed {
		next.Epoch = &epoch
	}
	responses.values[id] = &next
}

func configureContentOperations(t *testing.T, f fixture, commands ...sp.Command) *contentOperationResponses {
	t.Helper()
	responses := &contentOperationResponses{values: map[string]*store.SessionOperation{}, inserts: map[string]store.SessionOperation{}, receipts: map[string]sp.Operation{}, epochs: map[string]int64{}}
	for _, command := range commands {
		responses.values[command.OperationID] = nil
	}
	checkSession := func(id string) {
		t.Helper()
		if id != f.data.Session.Snapshot.SessionID {
			t.Fatalf("operation query targeted Session %s", id)
		}
	}
	lookup := func(id string) *store.SessionOperation {
		t.Helper()
		value, configured := responses.values[id]
		if !configured {
			t.Fatalf("unconfigured operation %s", id)
		}
		return value
	}
	f.dao.SessionOperationFn = func(ctx context.Context, sessionID, operationID string) (store.SessionOperation, error) {
		checkSession(sessionID)
		value := lookup(operationID)
		if value == nil {
			return store.SessionOperation{}, model.ErrNotFound
		}
		return *value, nil
	}
	f.dao.InsertSessionOperationFn = func(ctx context.Context, proposed store.SessionOperation) error {
		checkSession(proposed.SessionID)
		if lookup(proposed.OperationID) != nil {
			t.Fatal("operation insert repeated")
		}
		responses.inserts[proposed.OperationID] = proposed
		return nil
	}
	f.dao.PendingSessionOperationCountFn = func(ctx context.Context, sessionID string) (int, error) {
		checkSession(sessionID)
		return responses.pending, nil
	}
	f.dao.AcceptedSessionOperationsFn = func(ctx context.Context, sessionID string) ([]string, error) {
		checkSession(sessionID)
		return slices.Clone(responses.accepted), nil
	}
	f.dao.SetSessionOperationEpochFn = func(ctx context.Context, sessionID, operationID string, epoch int64) error {
		checkSession(sessionID)
		value := lookup(operationID)
		if value == nil {
			t.Fatal("epoch write preceded the operation insert")
		}
		responses.epochs[operationID] = epoch
		return nil
	}
	f.dao.SetSessionOperationReceiptFn = func(ctx context.Context, receipt sp.Operation) error {
		checkSession(receipt.SessionID)
		value := lookup(receipt.OperationID)
		if value == nil {
			t.Fatal("receipt write preceded the operation insert")
		}
		responses.receipts[receipt.OperationID] = receipt
		return nil
	}
	return responses
}

type contentWriteCounts struct {
	sessions, operations, receipts int
}

func selectContentHandle(t *testing.T, f fixture) {
	t.Helper()
	f.SelectTouchWrite(t)
	f.SelectSessionWrite(t)
}

func contentReadPhase(f fixture, ctx context.Context, scopes int) context.Context {
	counts := map[string]int{"LockTask": scopes, "LockCredential": scopes, "ProjectAccess": scopes, "SessionBotID": scopes, "LockSession": scopes}
	if f.data.Session.Snapshot.TestExecutionID != "" {
		counts["LockTask"], counts["ProjectAccess"] = 0, 0
		counts["LockCredential"] = scopes * 2
	}
	return f.dao.ContextPhase(ctx, counts)
}

func selectContentOffer(t *testing.T, f fixture) {
	t.Helper()
	if f.writes.Receipt == nil || f.writes.Receipt.State != "offered" {
		t.Fatal("offer did not propose the offered receipt")
	}
	f.SelectEpochWrite(t)
	f.SelectReceiptWrite(t)
	f.SelectSessionWrite(t)
	f.data.AcceptedIDs = nil
}

func observeContentLedger(t *testing.T, f fixture, private string) *contentWriteCounts {
	t.Helper()
	counts := &contentWriteCounts{}
	inspect := func(value any) {
		t.Helper()
		if bytes.Contains(encode(value), []byte(private)) {
			t.Fatalf("private content entered proposed durable write: %T", value)
		}
	}
	save := f.dao.SaveSessionFn
	f.dao.SaveSessionFn = func(ctx context.Context, value store.SessionRecord) error {
		inspect(value)
		counts.sessions++
		return save(ctx, value)
	}
	insert := f.dao.InsertSessionOperationFn
	f.dao.InsertSessionOperationFn = func(ctx context.Context, value store.SessionOperation) error {
		inspect(value)
		counts.operations++
		return insert(ctx, value)
	}
	receipt := f.dao.SetSessionOperationReceiptFn
	f.dao.SetSessionOperationReceiptFn = func(ctx context.Context, value sp.Operation) error {
		inspect(value)
		counts.receipts++
		return receipt(ctx, value)
	}
	return counts
}

func revokeContentCredential(t *testing.T, f fixture, actor model.Principal) {
	t.Helper()
	lock := f.dao.LockCredentialFn
	f.dao.LockCredentialFn = func(ctx context.Context, principal model.Principal, now time.Time) error {
		if principal == actor {
			return model.ErrNotFound
		}
		return lock(ctx, principal, now)
	}
}
