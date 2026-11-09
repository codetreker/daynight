package worker

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type syncStore struct {
	readErr   error
	writeErr  error
	outcome   store.TransactionOutcome
	committed bool
	reads     int
}

func (s *syncStore) WriteWorker(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
	if s.writeErr != nil {
		return store.Completion{}, s.writeErr
	}
	if err := operation(syncScope{}); err != nil {
		return store.Completion{}, err
	}
	s.committed = s.outcome == store.TransactionCommitted
	return store.Completion{Outcome: s.outcome}, nil
}
func (s *syncStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("unexpected native snapshot")
}
func (s *syncStore) ReadPromptSnapshot(ctx context.Context, _ func(store.PromptSnapshot) error) error {
	if !s.committed {
		panic("prompt snapshot before confirmed commit")
	}
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 5*time.Second {
		panic("missing prompt deadline")
	}
	s.reads++
	return s.readErr
}

type syncScope struct{ store.WorkerWriteDAO }

func (s syncScope) WorkerDAO() store.WorkerWriteDAO               { return s }
func (s syncScope) ObservedAt(context.Context) (time.Time, error) { return time.Unix(42, 0).UTC(), nil }
func (s syncScope) UpsertWorker(_ context.Context, input model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	input.LastReportedAt = time.Unix(41, 0).UTC()
	return input, nil
}
func (s syncScope) WorkerConfiguration(context.Context, string, string) (model.WorkerConfigurationResource, error) {
	return model.WorkerConfigurationResource{ObservationRevision: "0"}, nil
}

func TestReportSyncRetainsCommittedNativeReceiptOnSnapshotFailure(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	report := serviceWorkerReport()
	report.TaskInventory = nil
	report.Configuration = &model.WorkerConfigurationExchange{}
	selectors := []model.PromptSelector{{Key: model.PromptKey{Scope: model.PromptScopeUser}}, {Key: model.PromptKey{Scope: model.PromptScopeWorker}}}
	for _, tc := range []struct {
		name string
		err  error
		code string
	}{
		{"database", errors.New("private database details"), "unavailable"},
		{"deadline", context.DeadlineExceeded, "timeout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			database := &syncStore{readErr: tc.err, outcome: store.TransactionCommitted}
			result, err := NewWorkersWithPrompts(database, database).ReportSync(context.Background(), principal, id, report, selectors)
			if err != nil || database.reads != 1 || result.Native.Configuration == nil || result.Native.Configuration.ObservationRevision != "0" || result.Native.LastReportedAt.Unix() != 41 || len(result.Prompts) != len(selectors) {
				t.Fatalf("result=%+v reads=%d err=%v", result, database.reads, err)
			}
			for i, item := range result.Prompts {
				if item.Key != selectors[i].Key || item.Status != "error" || item.Error != tc.code || item.Value != nil || item.Revision != "" {
					t.Fatalf("unsafe prompt result: %+v", item)
				}
			}
		})
	}
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		database := &syncStore{outcome: outcome}
		if _, err := NewWorkersWithPrompts(database, database).ReportSync(context.Background(), principal, id, report, selectors); err == nil || database.reads != 0 {
			t.Fatalf("outcome=%s reads=%d err=%v", outcome, database.reads, err)
		}
	}
	database := &syncStore{writeErr: errors.New("write failed")}
	if _, err := NewWorkersWithPrompts(database, database).ReportSync(context.Background(), principal, id, report, selectors); err == nil || database.reads != 0 {
		t.Fatalf("write failure reads=%d err=%v", database.reads, err)
	}
	missing := &syncStore{outcome: store.TransactionCommitted}
	if _, err := NewWorkers(missing).ReportSync(context.Background(), principal, id, report, selectors); err == nil || missing.committed || missing.reads != 0 {
		t.Fatalf("missing reader committed=%v reads=%d err=%v", missing.committed, missing.reads, err)
	}
}
