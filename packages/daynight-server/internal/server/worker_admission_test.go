package server

import (
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

func TestWorkerReportHTTPActiveLimit(t *testing.T) {
	f := newWorkerHTTPFixture(t, io.Discard)
	id := uuid.NewString()
	body := workerSnapshotReportBody()
	snapshot := model.WorkerSnapshot{UserID: f.handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: workerInventoryTime(), Items: []model.WorkerObservedTask{}}}
	f.report(t, id, body, snapshot)
	rejectedID := uuid.NewString()
	response := f.reportResult(t, rejectedID, body, workerservice.WorkerReportResult{}, &model.Fault{Code: "active_worker_limit_exceeded", Message: "Active Worker limit exceeded."})
	assertProjectError(t, response, http.StatusConflict, "active_worker_limit_exceeded")
	f.report(t, id, body, snapshot)
}
func workerInventoryTime() *time.Time {
	value := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	return &value
}
