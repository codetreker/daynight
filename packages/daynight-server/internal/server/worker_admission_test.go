package server

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestWorkerReportHTTPActiveLimit(t *testing.T) {
	f := newWorkerHTTPFixture(t, io.Discard)
	id := uuid.NewString()
	body := workerSnapshotReportBody()
	snapshot := model.WorkerSnapshot{UserID: f.handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: workerInventoryTime(), Items: []model.WorkerObservedTask{}}}
	f.report(t, id, body, nil, []model.WorkerObservedTask{}, snapshot)
	rejectedID := uuid.NewString()
	scopes, admissions := 0, 0
	scope := &workerHTTPWriteScope{t: t, DAO: &workerHTTPWriteDAO{t: t}, AdmitWorkerCall: func(_ context.Context, u, w string, window time.Duration) (store.WorkerAdmission, error) {
		admissions++
		if u != f.handler.principal.UserID || w != rejectedID || window != 120*time.Second {
			workerHTTPFail(t, "incorrect refused-worker admission")
		}
		return store.WorkerAdmission{ObservedAt: f.now, ActiveCount: 100}, nil
	}}
	f.tx.WriteWorkerCall = func(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
		scopes++
		err := operation(scope)
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	assertProjectError(t, projectRequest(f.handler, http.MethodPost, "/api/v1/me/workers/"+rejectedID+"/report", jsonBody(t, body)), http.StatusConflict, "active_worker_limit_exceeded")
	if scopes != 1 || admissions != 1 {
		t.Fatalf("refused report calls: scopes=%d admissions=%d", scopes, admissions)
	}
	f.tx.WriteWorkerCall = nil
	// An existing active worker remains admissible at the complete owner limit.
	f.reportAdmission(t, id, body, nil, []model.WorkerObservedTask{}, snapshot, store.WorkerAdmission{ObservedAt: f.now, ActiveCount: 100, LastSeenAt: &f.now})
}
func workerInventoryTime() *time.Time {
	value := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	return &value
}
