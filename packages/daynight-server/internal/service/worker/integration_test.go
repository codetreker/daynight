package worker

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func pointer[T any](value T) *T { return &value }

func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	var transaction *store.TransactionError
	wrapped := errors.As(err, &transaction) && transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CleanupFailed
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" || (!wrapped && err.Error() != fault.Message) {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

func serviceWorkerReport() model.WorkerReport {
	now := time.Now().UTC()
	return model.WorkerReport{Telemetry: model.WorkerTelemetry{
		Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Snapshot worker"}, Platform: model.PlatformLinux,
		WorkingDirectory: "/workspace", SampledAt: now,
		OS:       model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerOS{Type: "Linux", Release: "6.8", Version: "Linux kernel", Arch: "x64"})},
		CPU:      model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerCPU{Model: "Test CPU", LogicalProcessors: 4, UsagePercent: 25})},
		Memory:   model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerMemory{UsedBytes: 1024, TotalBytes: 4096})},
		Disk:     model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerDisk{AvailableBytes: 2048, TotalBytes: 8192})},
		Versions: model.WorkerVersions{Daynight: "1.0.0", Herdr: model.WorkerProbe[string]{State: "not_running", CheckedAt: now}, Codex: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}, Copilot: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}},
	}}
}

func TestWorkerSnapshotsPreserveUnknownEmptyAndStaleObservations(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	workers := NewWorkers(database)
	ctx := context.Background()
	id := uuid.NewString()
	report := serviceWorkerReport()
	for range 2 {
		result, err := workers.Report(ctx, principal, strings.ToUpper(id), report)
		if err != nil || result.LastReportedAt.IsZero() || result.ObservedAt.Before(result.LastReportedAt) {
			t.Fatalf("initial report: %+v, %v", result, err)
		}
		detail, err := workers.Get(ctx, principal, id)
		if err != nil || detail.Worker.TaskSnapshot.State != model.WorkerTasksUnavailable || detail.Worker.TaskSnapshot.ObservedAt != nil || len(detail.Worker.TaskSnapshot.Items) != 0 {
			t.Fatalf("unknown inventory became idle: %+v, %v", detail, err)
		}
	}
	before, err := workers.Get(ctx, principal, id)
	if err != nil {
		t.Fatal(err)
	}
	report.TaskInventory = &model.WorkerTaskInventory{ObservedAt: time.Now().UTC(), Claims: []model.WorkerTaskReference{}}
	if _, err := workers.Report(ctx, principal, id, report); err != nil {
		t.Fatal(err)
	}
	idle, err := workers.Get(ctx, principal, id)
	if err != nil || idle.Worker.TaskSnapshot.State != model.WorkerTasksObserved || idle.Worker.TaskSnapshot.ObservedAt == nil || !idle.Worker.CreatedAt.Equal(before.Worker.CreatedAt) {
		t.Fatalf("known empty inventory: %+v, %v", idle, err)
	}
	report.TaskInventory = nil
	report.Telemetry.Machine.Name = "Reconnected worker"
	report.Telemetry.Memory = model.WorkerProbe[model.WorkerMemory]{State: "error", CheckedAt: time.Now().UTC(), Code: pointer("io_error")}
	if _, err := workers.Report(ctx, principal, id, report); err != nil {
		t.Fatal(err)
	}
	stale, err := workers.Get(ctx, principal, id)
	if err != nil || stale.Worker.TaskSnapshot.State != model.WorkerTasksStale || !reflect.DeepEqual(stale.Worker.TaskSnapshot.ObservedAt, idle.Worker.TaskSnapshot.ObservedAt) || stale.Worker.Telemetry.Machine.Name != report.Telemetry.Machine.Name || stale.Worker.Telemetry.Memory.State != "error" {
		t.Fatalf("reconnect lost truthful task or field state: %+v, %v", stale, err)
	}
	other := testsupport.ServicePrincipal(t, database)
	_, err = workers.Get(ctx, other, id)
	requireFault(t, err, "not_found")
	page, err := workers.List(ctx, other, model.PageRequest{Limit: 50})
	if err != nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("worker leaked to another account: %+v, %v", page, err)
	}
}

func TestWorkerSnapshotsPaginationClockAndExpiredDetail(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	ctx := context.Background()
	workers := NewWorkers(database)
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for _, id := range ids {
		if _, err := workers.Report(ctx, principal, id, serviceWorkerReport()); err != nil {
			t.Fatal(err)
		}
	}
	request := model.PageRequest{Limit: 1}
	seen := make(map[string]bool)
	for range ids {
		page, err := workers.List(ctx, principal, request)
		if err != nil || len(page.Items) != 1 || seen[page.Items[0].WorkerID] || page.ObservedAt.Before(page.Items[0].LastReportedAt) {
			t.Fatalf("stable worker page: %+v, %v", page, err)
		}
		seen[page.Items[0].WorkerID] = true
		for _, id := range ids {
			if _, err := workers.Report(ctx, principal, id, serviceWorkerReport()); err != nil {
				t.Fatal(err)
			}
		}
		if page.NextCursor != nil {
			_, err := workers.List(ctx, testsupport.ServicePrincipal(t, database), model.PageRequest{Limit: 1, Cursor: page.NextCursor})
			requireFault(t, err, "invalid_input")
		}
		request.Cursor = page.NextCursor
	}
	if request.Cursor != nil || len(seen) != len(ids) {
		t.Fatalf("pagination lost or repeated workers: %v", seen)
	}
	var lastReported time.Time
	if err := database.Pool.QueryRow(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()-interval '121 seconds' WHERE worker_id=$1 RETURNING last_seen_at", ids[0]).Scan(&lastReported); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		detail, err := workers.Get(ctx, principal, ids[0])
		if err != nil || !detail.Worker.LastReportedAt.Equal(lastReported) || detail.ObservedAt.Sub(detail.Worker.LastReportedAt) < 120*time.Second {
			t.Fatalf("reads refreshed or misreported the liveness clock: %+v, %v", detail, err)
		}
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()-interval '73 hours' WHERE worker_id=$1", ids[0]); err != nil {
		t.Fatal(err)
	}
	_, err := workers.Get(ctx, principal, ids[0])
	requireFault(t, err, "not_found")
}

func TestWorkerSnapshotServiceRefusalsAndStorageFailures(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	workers := NewWorkers(database)
	ctx := context.Background()
	id := uuid.NewString()
	_, err := workers.Report(ctx, model.Principal{}, id, serviceWorkerReport())
	requireFault(t, err, "unauthenticated")
	_, err = workers.List(ctx, model.Principal{}, model.PageRequest{Limit: 1})
	requireFault(t, err, "unauthenticated")
	_, err = workers.Get(ctx, model.Principal{}, id)
	requireFault(t, err, "unauthenticated")
	_, err = workers.Report(ctx, principal, "invalid", serviceWorkerReport())
	requireFault(t, err, "invalid_input")
	_, err = workers.Report(ctx, principal, id, model.WorkerReport{})
	requireFault(t, err, "invalid_input")
	_, err = workers.List(ctx, principal, model.PageRequest{Limit: 0})
	requireFault(t, err, "invalid_input")
	_, err = workers.Get(ctx, principal, "invalid")
	requireFault(t, err, "invalid_input")
	_, err = workers.Get(ctx, principal, id)
	requireFault(t, err, "not_found")
	database.Close()
	for _, invoke := range []func() error{
		func() error { _, err := workers.Report(ctx, principal, id, serviceWorkerReport()); return err },
		func() error { _, err := workers.List(ctx, principal, model.PageRequest{Limit: 1}); return err },
		func() error { _, err := workers.Get(ctx, principal, id); return err },
	} {
		var stored *store.Error
		if err := invoke(); !errors.As(err, &stored) || errors.Unwrap(err) == nil {
			t.Fatalf("storage failure was hidden: %v", err)
		}
	}
}

func cloudWorkerConfiguration(projectID string) model.WorkerConfiguration {
	projects := []model.WorkerProjectConfiguration{}
	if projectID != "" {
		projects = append(projects, model.WorkerProjectConfiguration{ProjectID: projectID, NativeOverrides: map[string]json.RawMessage{}})
	}
	return model.WorkerConfiguration{MaxConcurrent: 2, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: projects}
}

func importWorkerConfiguration(t *testing.T, workers *Workers, principal model.Principal, workerID string, value model.WorkerConfiguration) WorkerReportResult {
	t.Helper()
	report := serviceWorkerReport()
	report.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &value}
	result, err := workers.Report(context.Background(), principal, workerID, report)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestWorkerConfigurationConcurrentBootstrapAndIndependentCAS(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	ctx := context.Background()
	workers := NewWorkers(database)
	id := uuid.NewString()
	barrier := make(chan struct{})
	type reportResult struct {
		value WorkerReportResult
		err   error
	}
	results := make(chan reportResult, 2)
	for index := range 2 {
		go func(index int) {
			<-barrier
			value := cloudWorkerConfiguration("")
			value.MaxConcurrent = int64(index + 2)
			report := serviceWorkerReport()
			report.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &value}
			result, err := workers.Report(ctx, principal, id, report)
			results <- reportResult{value: result, err: err}
		}(index)
	}
	close(barrier)
	reports := [2]reportResult{<-results, <-results}
	var chosen int64
	for _, report := range reports {
		if report.err != nil {
			t.Fatal(report.err)
		}
		if report.value.Configuration == nil || report.value.Configuration.Desired == nil {
			t.Fatalf("bootstrap omitted desired configuration: %+v", report.value)
		}
		if chosen == 0 {
			chosen = report.value.Configuration.Desired.Value.MaxConcurrent
		}
		if report.value.Configuration.Desired.Revision != "1" || report.value.Configuration.Desired.Value.MaxConcurrent != chosen {
			t.Fatalf("bootstrap raced: %+v", report.value)
		}
	}
	initial, err := workers.Configuration(ctx, principal, id)
	if err != nil {
		t.Fatal(err)
	}
	barrier = make(chan struct{})
	mutations := make(chan error, 2)
	for index := range 2 {
		go func(index int) {
			<-barrier
			value := initial.Desired.Value
			value.MaxConcurrent = int64(index + 10)
			_, err := workers.PutConfiguration(ctx, principal, id, "1", value)
			mutations <- err
		}(index)
	}
	close(barrier)
	mutationResults := [2]error{<-mutations, <-mutations}
	winners := 0
	for _, err := range mutationResults {
		if err == nil {
			winners++
		} else {
			requireFault(t, err, "version_conflict")
		}
	}
	if winners != 1 {
		t.Fatalf("CAS winners: %d", winners)
	}
	report := serviceWorkerReport()
	report.Configuration = &model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}}
	observation, err := workers.Report(ctx, principal, id, report)
	if err != nil || !observation.Configuration.ObservationAccepted || observation.Configuration.Desired.Revision != "2" {
		t.Fatalf("old desired observation versus PUT: %+v %v", observation, err)
	}
	stored, err := workers.Configuration(ctx, principal, id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Observation.DesiredRevision != "1" || stored.Observation.ReportedAt.IsZero() {
		t.Fatalf("stored observation: %+v", stored)
	}
	stale, err := workers.Report(ctx, principal, id, report)
	if err != nil || stale.Configuration.ObservationAccepted || stale.Configuration.ObservationRevision != "1" {
		t.Fatalf("stale observation: %+v %v", stale, err)
	}
	legacy := serviceWorkerReport()
	if _, err := workers.Report(ctx, principal, id, legacy); err != nil {
		t.Fatal(err)
	}
	after, err := workers.Configuration(ctx, principal, id)
	if err != nil || !reflect.DeepEqual(stored.Observation, after.Observation) {
		t.Fatalf("non-accepted report advanced confirmation: %+v %v", after, err)
	}
	report.Configuration.Observation.BaseRevision = "1"
	report.Configuration.Observation.DesiredRevision = "3"
	_, err = workers.Report(ctx, principal, id, report)
	requireFault(t, err, "invalid_input")
}
